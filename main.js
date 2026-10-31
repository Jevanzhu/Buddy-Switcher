'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme, safeStorage } = require('electron');
const { execFile, spawn } = require('child_process');
const sync = require('./sync');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const fsp = require('fs/promises');

const APP_ID = 'com.cbswitcher.app';

// 档案根目录：与 CodeBuddy 自身配置（~/.codebuddy）同级，放在用户主目录下
// BUDDY_SWITCHER_HOME 只给测试用：指向临时目录就不会碰到真实的档案和 sync.json
const PROFILES_ROOT = process.env.BUDDY_SWITCHER_HOME || path.join(os.homedir(), '.buddy-switcher');
// 档案单独放一层，免得和 logs / .backup 这些混在一起被当成档案扫出来
const PROFILES_DIR = path.join(PROFILES_ROOT, 'profiles');
const META_ROOT = path.join(PROFILES_ROOT, '.meta');
const BACKUP_ROOT = path.join(PROFILES_ROOT, '.backup');
const LOG_ROOT = path.join(PROFILES_ROOT, 'logs');
const LAUNCHER_FILE = path.join(PROFILES_ROOT, 'launcher.json');

// 支持的 App。两者共用一个 auth 目录，各自有独立的产品会话文件。
const PRODUCTS = [
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    appName: 'CodeBuddy Desktop',
    exe: 'CodeBuddy Desktop.exe',
    bundleId: 'com.tencent.codebuddy.desktop',
    authPrefix: 'Tencent-Cloud.coding-copilot'
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    appName: 'WorkBuddy',
    exe: 'WorkBuddy.exe',
    bundleId: 'com.tencent.workbuddy.mac',
    authPrefix: 'workbuddy-desktop'
  }
];

const NAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,32}$/;
const RESERVED_NAMES = new Set(
  ['con', 'prn', 'aux', 'nul'].concat(
    Array.from({ length: 9 }, (_, i) => 'com' + (i + 1)),
    Array.from({ length: 9 }, (_, i) => 'lpt' + (i + 1))
  )
);

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE']);

let win = null;
// 启动时解析一次主程序位置，之后 getStatus 直接用，避免反复查注册表
const exeState = {};

// tasklist 一次要 200~400ms，不能放在 IPC 的同步路径上：
// 后台定时探，getStatus 只读上一次的结果，界面永远不等它。
const appState = new Map();
const probingApp = new Set();
const CACHE_TTL = 1500;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < CACHE_TTL ? hit.value : undefined;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

function invalidate() {
  cache.clear();
}

function refreshAppState(P) {
  if (probingApp.has(P.id)) return;
  probingApp.add(P.id);
  probeApp(P).then((s) => {
    probingApp.delete(P.id);
    if (appState.get(P.id) === s) return;
    appState.set(P.id, s);
    if (win && !win.isDestroyed()) win.webContents.send('status-changed', { product: P.id, appState: s });
  }).catch(() => probingApp.delete(P.id));
}

function appStateOf(P) {
  if (!appState.has(P.id)) appState.set(P.id, 'unknown');
  refreshAppState(P);
  return appState.get(P.id);
}

function log(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('app-log', msg);
  console.log(msg);
  try {
    const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
    fs.mkdirSync(LOG_ROOT, { recursive: true });
    fs.appendFileSync(path.join(LOG_ROOT, new Date().toISOString().slice(0, 10) + '.log'), line, 'utf8');
  } catch (e) { /* 日志落盘失败不影响主流程 */ }
}

function execP(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) =>
      resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function retry(fn, times = 4) {
  let last;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!RETRY_CODES.has(e.code)) throw e;
      await sleep(150 * (i + 1));
    }
  }
  throw last;
}

function productById(id) {
  return PRODUCTS.find((p) => p.id === id) || PRODUCTS[0];
}

// 账号身份只由这一处决定，各 App 读的是同一个目录，只是文件名不同：
//   Windows: %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<产品id>.info
//   macOS:   ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/<产品id>.info
// 内容为 JSON：account.uid / auth.accessToken / auth.refreshToken 是明文；
// WorkBuddy 额外把 nickname、accessToken 包成 $wbEncrypted 信封，本机解不开，只能读 uid / uin。
function authDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support',
      'CodeBuddyExtension', 'Data', 'Public', 'auth');
  }
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
}

function isProductAuth(file, P) {
  return file.startsWith(P.authPrefix) && file.endsWith('.info');
}

async function authFiles(dir, P) {
  try {
    return (await fsp.readdir(dir)).filter((f) => isProductAuth(f, P));
  } catch (e) {
    return [];
  }
}

async function hasCredentials(dir, P) {
  return (await authFiles(dir, P)).length > 0;
}

// WorkBuddy 把 nickname 存成 { $wbEncrypted:1, envelope:"..." } 的 AES 信封，本机拿不到明文。
// 但同一个账号在别的产品里是明文昵称，且所有产品的 .info 都在同一个目录 —— 按 uid 借来显示。
async function borrowNickname(dir, uid) {
  if (!uid) return '';
  let entries;
  try { entries = await fsp.readdir(dir); } catch (e) { return ''; }
  for (const f of entries) {
    if (!f.endsWith('.info')) continue;
    let j;
    try { j = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    const list = [j.account].concat(Array.isArray(j.accounts) ? j.accounts : []).filter(Boolean);
    for (const a of list) {
      if (a.uid === uid && typeof a.nickname === 'string' && a.nickname) return a.nickname;
    }
  }
  return '';
}

// 从会话文件里读出账号身份，用于在界面上标出这是谁。
// 文件名带时间戳/pid 的是轮转副本，优先读不带的那份。
async function readAccountInfo(dir, P) {
  const files = await authFiles(dir, P);
  const rotated = (f) => /\.\d{4,6}\./.test(f);
  files.sort((a, b) => (rotated(a) ? 1 : 0) - (rotated(b) ? 1 : 0));
  for (const f of files) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
      const account = j.account || {};
      if (!account.uid) continue;
      let nickname = typeof account.nickname === 'string' ? account.nickname : '';
      if (!nickname) nickname = await borrowNickname(dir, account.uid);
      return { uid: account.uid, nickname, uin: typeof account.uin === 'string' ? account.uin : '' };
    } catch (e) { /* 换下一个 */ }
  }
  return null;
}

// running | stopped | unknown（unknown 绝不能当成 stopped，否则会在程序运行中动数据）
async function probeApp(P) {
  if (process.platform === 'darwin') {
    const r = await execP('pgrep', ['-f', P.appName + '.app/Contents/MacOS']);
    if (r.err) return r.err.code === 1 ? 'stopped' : 'unknown';
    return 'running';
  }
  if (process.platform === 'win32') {
    const r = await execP('tasklist', ['/FI', 'IMAGENAME eq ' + P.exe, '/FO', 'CSV', '/NH']);
    if (r.err && !r.stdout.trim()) return 'unknown';
    const hit = r.stdout.split(/\r?\n/).some((line) => {
      const t = line.trim();
      return t.startsWith('"') && t.toLowerCase().includes(P.exe.toLowerCase());
    });
    return hit ? 'running' : 'stopped';
  }
  return 'unknown';
}

async function waitForStop(P, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    if (await probeApp(P) === 'stopped') return true;
  }
  return false;
}

// macOS 没有 taskkill：先按 bundle id 让 App 自己退出（改过 App 名字也能找到），
// 不行再按名字试一次，仍失败就等下面的强杀兜底。
async function quitOnMac(P) {
  const byId = P.bundleId
    ? await execP('osascript', ['-e', 'tell application id "' + P.bundleId + '" to quit'])
    : { err: new Error('没有 bundle id') };
  if (!byId.err) return;
  const byName = await execP('osascript', ['-e', 'quit app "' + P.appName + '"']);
  if (byName.err) {
    log('! 优雅退出失败：' + (byName.stderr || byName.err.message).trim());
  }
}

async function quitApp(P) {
  const state = await probeApp(P);
  if (state === 'unknown') {
    throw new Error('无法确认 ' + P.appName + ' 的运行状态，为避免破坏账号数据已中止。');
  }
  if (state === 'stopped') {
    log('· ' + P.appName + ' 当前未运行');
    return;
  }

  log('→ 正在退出 ' + P.appName + ' ...');
  if (process.platform === 'darwin') {
    await quitOnMac(P);
  } else {
    await execP('taskkill', ['/T', '/IM', P.exe]);
  }

  if (await waitForStop(P, 3000)) {
    log('✓ 已正常退出');
    return;
  }

  log('! 3 秒内未退出，强制结束 ...');
  if (process.platform === 'darwin') {
    await execP('pkill', ['-9', '-f', P.appName + '.app/Contents/MacOS']);
  } else {
    await execP('taskkill', ['/F', '/T', '/IM', P.exe]);
  }

  if (await waitForStop(P, 5000)) {
    log('✓ 已强制退出');
    return;
  }
  throw new Error(P.appName + ' 无法退出，请手动结束后重试。');
}

async function readLauncherMap() {
  try {
    const j = JSON.parse(await fsp.readFile(LAUNCHER_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    return {};
  }
}

async function readLauncherPath(P) {
  const map = await readLauncherMap();
  if (map[P.id]) return map[P.id];
  // 旧版只有一个 exePath 字段，属于 CodeBuddy
  if (P.id === 'codebuddy' && typeof map.exePath === 'string') return map.exePath;
  return '';
}

async function writeLauncherPath(P, exePath) {
  const map = await readLauncherMap();
  map[P.id] = exePath;
  delete map.exePath;
  await fsp.mkdir(PROFILES_ROOT, { recursive: true });
  await fsp.writeFile(LAUNCHER_FILE, JSON.stringify(map, null, 2), 'utf8');
  exeState[P.id] = exePath;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

// Windows 存的是 .exe 文件，macOS 存的是 .app 目录
function isLauncherPath(p) {
  try { return process.platform === 'darwin' ? fs.statSync(p).isDirectory() : fs.statSync(p).isFile(); }
  catch (e) { return false; }
}

function standardExeCandidates(P) {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      path.join('/Applications', P.appName + '.app'),
      path.join(home, 'Applications', P.appName + '.app')
    ];
  }
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const list = [
    path.join(local, 'Programs', P.appName, P.exe),
    path.join(local, P.appName, P.exe)
  ];
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const root = process.env[key];
    if (root) list.push(path.join(root, P.appName, P.exe));
  }
  return list;
}

async function registryExeCandidates(P) {
  const found = [];
  const appPathKey = 'Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + P.exe;
  for (const root of ['HKCU', 'HKLM']) {
    const r = await execP('reg', ['query', root + '\\' + appPathKey, '/ve']);
    const m = r.stdout.match(/REG_SZ\s+([A-Za-z]:\\[^\r\n]*?\.exe)/i);
    if (m) found.push(m[1].trim());
  }
  const uninstallKeys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];
  for (const key of uninstallKeys) {
    const r = await execP('reg', ['query', key, '/s', '/f', P.appName, '/d']);
    if (r.err && !r.stdout) continue;
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/([A-Za-z]:\\[^\r\n]*?\.exe)(?:,\s*\d+)?\s*$/i);
      if (m) found.push(m[1].trim());
    }
  }
  return found;
}

async function resolveExe(P) {
  const cached = await readLauncherPath(P);
  if (cached && isLauncherPath(cached)) {
    exeState[P.id] = cached;
    return cached;
  }

  log('→ 正在定位 ' + P.appName + ' 主程序 ...');
  for (const c of standardExeCandidates(P)) {
    if (isLauncherPath(c)) {
      await writeLauncherPath(P, c).catch(() => {});
      return c;
    }
  }
  // 注册表只有 Windows 有；macOS 走完 /Applications 探测就算完
  if (process.platform === 'win32') {
    for (const c of await registryExeCandidates(P)) {
      if (isFile(c)) {
        await writeLauncherPath(P, c).catch(() => {});
        return c;
      }
    }
  }
  exeState[P.id] = '';
  return '';
}

async function pickExe(P) {
  const mac = process.platform === 'darwin';
  const r = await dialog.showOpenDialog(win, {
    title: '选择 ' + P.appName + (mac ? ' 应用' : ' 主程序'),
    buttonLabel: '使用此程序',
    properties: ['openFile'],
    // macOS 的 .app 是目录，默认按「包」当文件选
    filters: [{ name: mac ? '应用程序' : '可执行文件', extensions: [mac ? 'app' : 'exe'] }]
  });
  if (r.canceled || !r.filePaths.length) return '';
  await writeLauncherPath(P, r.filePaths[0]);
  log('✓ 已记住 ' + P.label + ' 的主程序位置');
  return r.filePaths[0];
}

async function launchApp(P) {
  if (process.platform === 'darwin') {
    // 按 bundle id 启动，不依赖 App 装在哪、叫什么
    let r = P.bundleId ? await execP('open', ['-b', P.bundleId]) : { err: new Error('没有 bundle id') };
    if (r.err) r = await execP('open', ['-a', P.appName]);
    if (r.err) throw new Error('启动失败：' + (r.stderr || r.err.message));
  } else {
    let exe = await resolveExe(P);
    if (!exe) exe = await pickExe(P);
    if (!exe) throw new Error('未找到 ' + P.appName + ' 主程序，已取消启动。');
    await new Promise((resolve, reject) => {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await sleep(400);
    if (await probeApp(P) === 'running') {
      log('✓ ' + P.appName + ' 已启动');
      return;
    }
  }
  log('! 已发出启动命令，但暂未检测到进程，请留意桌面');
}

function profilesDir(P) {
  return path.join(PROFILES_DIR, P.id);
}

function currentFile(P) {
  return path.join(PROFILES_ROOT, 'CURRENT-' + P.id);
}

function metaFile(P, name) {
  return path.join(META_ROOT, P.id, name + '.json');
}

async function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  async function walk(d) {
    const entries = await fsp.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        files++;
        try { bytes += (await fsp.stat(p)).size; } catch (err) { /* 忽略单个文件 */ }
      }
    }
  }
  await walk(dir).catch(() => {});
  return { bytes, files };
}

async function writeMeta(P, name, data) {
  await fsp.mkdir(path.dirname(metaFile(P, name)), { recursive: true });
  await fsp.writeFile(metaFile(P, name), JSON.stringify(data, null, 2), 'utf8');
}

async function readMeta(P, name) {
  try { return JSON.parse(await fsp.readFile(metaFile(P, name), 'utf8')); }
  catch (e) { return null; }
}

function validateName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!NAME_RE.test(name)) {
    throw new Error('档案名只能包含中文、字母、数字、_ 或 -，长度 1-32');
  }
  if (process.platform === 'win32' && RESERVED_NAMES.has(name.toLowerCase())) {
    throw new Error('「' + name + '」是 Windows 保留名称，请换一个');
  }
  return name;
}

// Windows 文件系统不区分大小写，按实际目录名解析
function findProfileDir(P, name) {
  if (!name) return '';
  const root = profilesDir(P);
  if (!fs.existsSync(root)) return '';
  const target = process.platform === 'win32' ? name.toLowerCase() : name;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const cmp = process.platform === 'win32' ? e.name.toLowerCase() : e.name;
    if (cmp === target) return path.join(root, e.name);
  }
  return '';
}

async function archiveProfile(P, dir, name) {
  try {
    await fsp.mkdir(BACKUP_ROOT, { recursive: true });
    const prefix = P.id + '-' + name + '-';
    const dest = path.join(BACKUP_ROOT, prefix + Date.now());
    await retry(() => fsp.rename(dir, dest));
    const entries = (await fsp.readdir(BACKUP_ROOT))
      .filter((n) => n.startsWith(prefix))
      .sort()
      .reverse();
    for (const old of entries.slice(3)) {
      await fsp.rm(path.join(BACKUP_ROOT, old), { recursive: true, force: true }).catch(() => {});
    }
  } catch (e) {
    log('! 旧档案备份失败（保留原目录）：' + e.message);
  }
}

async function readCurrent(P) {
  try {
    return (await fsp.readFile(currentFile(P), 'utf8')).trim();
  } catch (e) {
    // 旧版只有一个 CURRENT，属于 CodeBuddy
    if (P.id === 'codebuddy') {
      try { return (await fsp.readFile(path.join(PROFILES_ROOT, 'CURRENT'), 'utf8')).trim(); }
      catch (err) { return ''; }
    }
    return '';
  }
}

async function writeCurrent(P, name) {
  await fsp.mkdir(PROFILES_ROOT, { recursive: true });
  await fsp.writeFile(currentFile(P), name, 'utf8');
}

// 早期版本把档案直接放在根目录，会和 logs 混在一起；启动时归位
async function migrateLayout() {
  const legacyRoot = (name) => ['auth', 'Network', 'Local Storage']
    .some((p) => fs.existsSync(path.join(PROFILES_ROOT, name, p)));

  // 1) .buddy-switcher/<档案名> -> profiles/codebuddy/<档案名>
  try {
    const entries = await fsp.readdir(PROFILES_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || !NAME_RE.test(e.name)) continue;
      if (!legacyRoot(e.name)) continue;
      const to = path.join(profilesDir(productById('codebuddy')), e.name);
      if (fs.existsSync(to)) continue;
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await retry(() => fsp.rename(path.join(PROFILES_ROOT, e.name), to))
        .then(() => log('· 旧档案「' + e.name + '」已移入 profiles/codebuddy/'))
        .catch((err) => log('! 旧档案「' + e.name + '」迁移失败：' + err.message));
    }
  } catch (e) { /* 根目录还不存在 */ }

  // 2) profiles/<档案名> -> profiles/codebuddy/<档案名>
  try {
    const entries = await fsp.readdir(PROFILES_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || !NAME_RE.test(e.name)) continue;
      if (PRODUCTS.some((p) => p.id === e.name)) continue;
      const from = path.join(PROFILES_DIR, e.name);
      if (!fs.existsSync(path.join(from, 'auth')) && !legacyRoot(e.name)) continue;
      const to = path.join(profilesDir(productById('codebuddy')), e.name);
      if (fs.existsSync(to)) continue;
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await retry(() => fsp.rename(from, to))
        .then(() => log('· 档案「' + e.name + '」已归到 CodeBuddy'))
        .catch((err) => log('! 档案「' + e.name + '」迁移失败：' + err.message));
    }
  } catch (e) { /* 还没有档案 */ }

  // 3) .meta/<档案名>.json -> .meta/codebuddy/<档案名>.json
  try {
    const entries = await fsp.readdir(META_ROOT, { withFileTypes: true });
    const dir = path.join(META_ROOT, 'codebuddy');
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      await fsp.mkdir(dir, { recursive: true });
      const to = path.join(dir, e.name);
      if (fs.existsSync(to)) continue;
      await retry(() => fsp.rename(path.join(META_ROOT, e.name), to)).catch(() => {});
    }
  } catch (e) { /* 还没有 meta */ }
}

async function listProfiles(P) {
  let entries;
  try {
    entries = await fsp.readdir(profilesDir(P), { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const names = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && NAME_RE.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));

  return Promise.all(names.map(async (name) => {
    const meta = await readMeta(P, name);
    let savedAt = meta && meta.savedAt;
    if (!savedAt) {
      try { savedAt = (await fsp.stat(path.join(profilesDir(P), name))).mtime.toISOString(); }
      catch (e) { savedAt = ''; }
    }
    const dir = path.join(profilesDir(P), name, 'auth');
    let nickname = (meta && meta.nickname) || '';
    let uin = (meta && meta.uin) || '';
    // 老档案的 meta 里没存昵称（WorkBuddy 那份还带加密），现读现补，不用重新保存
    if (!nickname && fs.existsSync(dir)) {
      const acc = await readAccountInfo(dir, P);
      if (acc) {
        nickname = acc.nickname || await borrowNickname(authDir(), acc.uid);
        uin = uin || acc.uin;
      }
    }

    return {
      name,
      savedAt: savedAt || '',
      bytes: (meta && meta.bytes) || 0,
      files: (meta && meta.files) || 0,
      accountUid: (meta && meta.accountUid) || '',
      nickname,
      uin,
      hasSession: fs.existsSync(path.join(profilesDir(P), name, 'auth'))
    };
  }));
}

// CURRENT-<产品> 只是上次操作留下的标记，真实身份以 auth 目录为准。
// 打开 App、刷新状态、切换前都按 uid 对一次档案：用户在外面换了号，标记要跟着走；
// 当前登录没存过档案就清掉标记，避免下次切换把登录回存进错误的档案。
async function reconcileCurrent(P, state) {
  const account = state && state.account !== undefined
    ? state.account
    : await readAccountInfo(authDir(), P);
  const profiles = state && state.profiles ? state.profiles : await listProfiles(P);
  const current = state && state.current !== undefined ? state.current : await readCurrent(P);
  const uid = account && account.uid;
  const matches = [];

  if (uid) {
    for (const p of profiles) {
      if (p.accountUid === uid) {
        matches.push(p);
      } else if (!p.accountUid && p.hasSession) {
        // 老档案的 meta 里可能没有 uid，读档案内的会话再比一次
        const acc = await readAccountInfo(path.join(profilesDir(P), p.name, 'auth'), P);
        if (acc && acc.uid === uid) matches.push(p);
      }
    }
  }

  if (!matches.length) {
    if (current) await fsp.rm(currentFile(P), { force: true }).catch(() => {});
    return '';
  }
  if (matches.some((p) => p.name.toLowerCase() === String(current).toLowerCase())) {
    return current;
  }
  // 同一个账号存了多份时优先保留已有标记，否则取最近保存的那份
  const best = matches.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')))[0];
  await writeCurrent(P, best.name);
  return best.name;
}

// 只搬本产品的会话文件，同目录下别的 App 的会话保持原样
async function copyAuth(P, from, to) {
  const files = await authFiles(from, P);
  await fsp.mkdir(to, { recursive: true });
  for (const f of files) {
    await retry(() => fsp.copyFile(path.join(from, f), path.join(to, f)));
  }
  return files;
}

function profileAuth(profileDir) {
  const nested = path.join(profileDir, 'auth');
  return fs.existsSync(nested) ? nested : '';
}

// 把当前登录会话快照成档案：先写临时目录，校验后再原子换名
async function snapshotTo(P, name) {
  const dest = path.join(profilesDir(P), name);
  const stamp = Date.now();
  const staging = path.join(profilesDir(P), '.' + name + '.tmp-' + stamp);
  const previous = path.join(profilesDir(P), '.' + name + '.old-' + stamp);
  const src = authDir();

  try {
    await fsp.mkdir(profilesDir(P), { recursive: true });
    if (!fs.existsSync(src)) throw new Error('未找到账号会话目录：' + src);

    log('→ 正在读取 ' + P.label + ' 登录会话 ...');
    await fsp.mkdir(staging, { recursive: true });
    const copied = await copyAuth(P, src, path.join(staging, 'auth'));
    if (!copied.length) throw new Error('复制结果中没有找到登录凭据，已中止保存');

    const account = await readAccountInfo(path.join(staging, 'auth'), P);
    // staging 里只有本产品的文件，加密昵称要回原目录按 uid 借
    const nickname = (account && account.nickname) ||
      await borrowNickname(src, account && account.uid);
    const stats = await dirStats(staging);
    await writeMeta(P, name, {
      name,
      savedAt: new Date().toISOString(),
      bytes: stats.bytes,
      files: stats.files,
      accountUid: (account && account.uid) || '',
      nickname: nickname || '',
      uin: (account && account.uin) || '',
      appVersion: app.getVersion()
    });
  } catch (e) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw e;
  }

  const hadOld = fs.existsSync(dest);
  if (hadOld) await retry(() => fsp.rename(dest, previous));
  try {
    await retry(() => fsp.rename(staging, dest));
  } catch (e) {
    if (hadOld && fs.existsSync(previous)) {
      await retry(() => fsp.rename(previous, dest)).catch(() => {});
    }
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  if (hadOld) await archiveProfile(P, previous, name);
}

// 换入档案：只替换本产品的会话文件，先备份当前会话，失败可回滚
async function restoreProfile(P, name) {
  const dir = findProfileDir(P, name);
  if (!dir) throw new Error('档案不存在：' + name);
  const src = profileAuth(dir);
  if (!src || !(await hasCredentials(src, P))) {
    throw new Error('档案「' + name + '」中没有登录凭据，已中止切换');
  }

  const target = authDir();
  const backupDir = path.join(BACKUP_ROOT, 'auth-' + P.id + '-' + Date.now());
  const moved = [];
  let copied = [];

  try {
    await fsp.mkdir(target, { recursive: true });
    const current = await authFiles(target, P);
    if (current.length) {
      log('→ 备份当前 ' + P.label + ' 登录会话 ...');
      await fsp.mkdir(backupDir, { recursive: true });
      for (const f of current) {
        await retry(() => fsp.rename(path.join(target, f), path.join(backupDir, f)));
        moved.push(f);
      }
    }
    copied = await copyAuth(P, src, target);
  } catch (e) {
    log('! 换入失败，正在回滚 ...');
    for (const f of copied) await fsp.rm(path.join(target, f), { force: true }).catch(() => {});
    for (const f of moved) {
      await retry(() => fsp.rename(path.join(backupDir, f), path.join(target, f))).catch(() => {});
    }
    throw new Error('换入登录会话失败，已尝试恢复原数据：' + e.message);
  }

  if (moved.length) {
    await retry(() => fsp.rm(backupDir, { recursive: true, force: true }))
      .catch(() => log('! 旧会话备份未能删除，可手动清理：' + backupDir));
  }
}

async function confirm(options) {
  const { response } = await dialog.showMessageBox(win, {
    type: options.danger ? 'warning' : 'question',
    title: options.title,
    message: options.message,
    detail: options.detail,
    buttons: [options.okLabel, '取消'],
    defaultId: options.danger ? 1 : 0,
    cancelId: 1,
    noLink: true
  });
  return response === 0;
}

async function listProfilesCached(P) {
  const hit = cacheGet('profiles:' + P.id);
  if (hit) return hit;
  return cacheSet('profiles:' + P.id, await listProfiles(P));
}

async function accountCached(P) {
  const hit = cacheGet('account:' + P.id);
  if (hit) return hit;
  return cacheSet('account:' + P.id, await readAccountInfo(authDir(), P));
}

async function getStatus(productId) {
  const P = productById(productId);
  const [currentRaw, profiles, account] = await Promise.all([
    readCurrent(P),
    listProfilesCached(P),
    accountCached(P)
  ]);
  const current = await reconcileCurrent(P, { current: currentRaw, profiles, account });
  const state = appStateOf(P);
  return {
    platform: process.platform,
    version: app.getVersion(),
    product: P.id,
    products: PRODUCTS.map((p) => ({
      id: p.id,
      label: p.label,
      appName: p.appName,
      installed: exeState[p.id] === undefined ? true : !!exeState[p.id]
    })),
    current,
    profiles,
    appState: state,
    appRunning: state === 'running',
    account,
    authDir: authDir(),
    authDirExists: fs.existsSync(authDir()),
    profilesRoot: profilesDir(P)
  };
}

async function saveProfile(productId, rawName) {
  const P = productById(productId);
  const name = validateName(rawName);
  const src = authDir();
  if (!fs.existsSync(src)) throw new Error('未找到账号会话目录：' + src);
  if (!(await hasCredentials(src, P))) {
    throw new Error('没有检测到 ' + P.label + ' 的登录凭据，请先登录再保存');
  }

  const account = await readAccountInfo(src, P);
  const who = account && account.nickname ? '「' + account.nickname + '」' : '当前账号';

  const ok = await confirm({
    title: '保存 ' + P.label + ' 账号',
    message: '把' + who + '保存为档案「' + name + '」？',
    detail: P.appName + ' 将被关闭：3 秒内未退出会自动强制结束；保存完成后自动重启。正在进行的会话会中断。',
    okLabel: '保存并重启'
  });
  if (!ok) return { cancelled: true };

  await quitApp(P);
  await sleep(400);
  await snapshotTo(P, name);
  await writeCurrent(P, name);
  log('✓ 已保存 ' + P.label + ' 档案「' + name + '」');

  try {
    await launchApp(P);
  } catch (e) {
    throw new Error('档案已保存，但启动 ' + P.appName + ' 失败：' + e.message);
  }
  invalidate();
  return { saved: name };
}

async function switchTo(productId, rawName) {
  const P = productById(productId);
  const name = validateName(rawName);
  const dir = findProfileDir(P, name);
  if (!dir) throw new Error('档案不存在：' + rawName);
  const actual = path.basename(dir);

  // 先按当前登录账号校准标记，避免把现在的会话回存进旧档案
  const current = await reconcileCurrent(P);
  if (current && current.toLowerCase() === actual.toLowerCase()) {
    throw new Error('「' + actual + '」就是当前账号，无需切换');
  }

  const ok = await confirm({
    title: '切换 ' + P.label + ' 账号',
    message: '切换到档案「' + actual + '」？',
    detail: P.appName + ' 将被关闭：3 秒内未退出会自动强制结束；换入登录会话后自动重启。正在进行的会话会中断。',
    okLabel: '切换并重启'
  });
  if (!ok) return { cancelled: true };

  const prevDir = findProfileDir(P, current);
  await quitApp(P);
  await sleep(400);

  if (prevDir) {
    try {
      await snapshotTo(P, path.basename(prevDir));
      log('✓ 已回存当前档案「' + path.basename(prevDir) + '」');
    } catch (e) {
      log('! 当前账号回存失败（继续切换）：' + e.message);
    }
  }

  await restoreProfile(P, actual);
  await writeCurrent(P, actual);
  log('✓ 已切换到 ' + P.label + ' 档案「' + actual + '」');

  try {
    await launchApp(P);
  } catch (e) {
    throw new Error('账号已切换，但启动 ' + P.appName + ' 失败：' + e.message);
  }
  invalidate();
  return { switched: actual };
}

async function deleteProfile(productId, rawName) {
  const P = productById(productId);
  const dir = findProfileDir(P, rawName);
  if (!dir) throw new Error('档案不存在：' + rawName);
  const name = path.basename(dir);

  const ok = await confirm({
    title: '删除档案',
    message: '确定删除 ' + P.label + ' 档案「' + name + '」？',
    detail: '该档案中保存的登录凭据会被永久删除，无法恢复。',
    okLabel: '删除',
    danger: true
  });
  if (!ok) return { cancelled: true };

  await retry(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.rm(metaFile(P, name), { force: true }).catch(() => {});
  const current = await readCurrent(P);
  if (current && current.toLowerCase() === name.toLowerCase()) {
    await fsp.rm(currentFile(P), { force: true }).catch(() => {});
  }
  log('✓ 已删除 ' + P.label + ' 档案「' + name + '」');
  invalidate();
  return { deleted: name };
}

// 新建账号：把当前登录会话挪到备份区，让 App 回到未登录状态。
// 不要用「退出登录」——那会让服务端吊销 token，已存的档案就废了。
async function archiveIdentity(P) {
  const dest = path.join(BACKUP_ROOT, 'identity-' + P.id + '-' + Date.now());
  const from = authDir();
  const files = await authFiles(from, P);
  if (files.length) {
    await fsp.mkdir(dest, { recursive: true });
    for (const f of files) {
      await retry(() => fsp.rename(path.join(from, f), path.join(dest, f)))
        .catch((e) => log('! 未能移出登录会话 ' + f + '：' + e.message));
    }
  }
  const prefix = 'identity-' + P.id + '-';
  const entries = (await fsp.readdir(BACKUP_ROOT).catch(() => []))
    .filter((n) => n.startsWith(prefix))
    .sort()
    .reverse();
  for (const old of entries.slice(3)) {
    await fsp.rm(path.join(BACKUP_ROOT, old), { recursive: true, force: true }).catch(() => {});
  }
  return dest;
}

async function startFresh(productId) {
  const P = productById(productId);
  const ok = await confirm({
    title: '新建 ' + P.label + ' 账号',
    message: '清空 ' + P.label + ' 当前登录状态，改用另一个账号登录？',
    detail: '当前登录会被移出并备份到 .backup 目录，已保存的档案不受影响。' + P.appName + ' 会关闭并自动重启，重启后请登录新账号，再点「保存为档案」。',
    okLabel: '清空并重启',
    danger: true
  });
  if (!ok) return { cancelled: true };

  await quitApp(P);
  await sleep(400);
  const dest = await archiveIdentity(P);
  await fsp.rm(currentFile(P), { force: true }).catch(() => {});
  log('✓ 已清空 ' + P.label + ' 登录（备份：' + dest + '）');

  try {
    await launchApp(P);
  } catch (e) {
    throw new Error('已清空登录，但启动 ' + P.appName + ' 失败：' + e.message);
  }
  invalidate();
  return { fresh: true };
}

// ---------- 跨设备同步（WebDAV，档案本地上加密后上传） ----------

const SYNC_FILE = path.join(PROFILES_ROOT, 'sync.json');

function readSyncRaw() {
  try { return JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8')); } catch (e) { return {}; }
}

function writeSyncRaw(data) {
  fs.mkdirSync(PROFILES_ROOT, { recursive: true });
  fs.writeFileSync(SYNC_FILE, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function unlockSecret(raw) {
  if (!raw || !raw.secret || !safeStorage.isEncryptionAvailable()) return null;
  try { return JSON.parse(safeStorage.decryptString(Buffer.from(raw.secret, 'base64'))); }
  catch (e) { return null; }
}

function syncSettings() {
  const raw = readSyncRaw();
  return {
    url: raw.url || '',
    dir: raw.dir || 'buddy-switcher',
    user: raw.user || '',
    auto: !!raw.auto,
    every: Number(raw.every) || 15,
    device: hostSlug() || raw.device || '',
    lastAt: autoLast,
    nextAt: autoNext,
    hasSecret: !!unlockSecret(raw)
  };
}

function syncSave(cfg) {
  const raw = readSyncRaw();
  const url = String(cfg.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('服务器地址要以 http:// 或 https:// 开头');
  raw.url = url;
  raw.dir = String(cfg.dir || '').trim().replace(/^\/+|\/+$/g, '') || 'buddy-switcher';
  raw.user = String(cfg.user || '').trim();
  raw.auto = !!cfg.auto;
  raw.every = Math.max(1, Math.min(1440, Number(cfg.every) || 15));

  const pass = cfg.pass === undefined ? '' : String(cfg.pass);
  if (pass) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存密码');
    raw.secret = safeStorage.encryptString(JSON.stringify({ pass })).toString('base64');
  }
  writeSyncRaw(raw);
  // 保存只负责存盘 + 开始/继续计时，绝不顺带上传
  startAutoSync();
  return syncSettings();
}

function syncConfigOrThrow() {
  const raw = readSyncRaw();
  const secret = unlockSecret(raw);
  if (!raw.url) throw new Error('还没配置 WebDAV 地址');
  if (!secret || !secret.pass) throw new Error('还没填 WebDAV 密码');
  // 档案用 WebDAV 密码派生密钥加密，不再单独设同步密码
  return { url: raw.url, dir: raw.dir || 'buddy-switcher', user: raw.user, pass: secret.pass, key: secret.pass };
}

// ---------- 自动同步 ----------

let autoTimer = null;
let autoEvery = 0;
let autoLast = '';
let autoNext = '';
let syncRunning = false;
let mutating = 0;

function stopAutoSync() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
  autoEvery = 0;
  autoNext = '';
}

// 自动同步只在"到点"时跑：保存配置、启动程序都只是开始/继续计时，
// 不会顺手同步一次，否则用户点一下「保存配置」就会莫名其妙看到一屏上传。
function startAutoSync() {
  const raw = readSyncRaw();
  const on = !!raw.auto;
  const every = Math.max(1, Number(raw.every) || 15);

  if (!on) { stopAutoSync(); return; }
  // 间隔没变就保持已有计时，别把倒计时重置回原点
  if (autoTimer && every === autoEvery) return;

  stopAutoSync();
  autoEvery = every;
  const ms = every * 60000;
  autoNext = new Date(Date.now() + ms).toISOString();
  autoTimer = setInterval(() => {
    autoNext = new Date(Date.now() + ms).toISOString();
    runAutoSync();
  }, ms);
  log('· 自动同步：每 ' + every + ' 分钟一次');
}

async function runAutoSync() {
  if (syncRunning || mutating > 0) return;
  const raw = readSyncRaw();
  if (!raw.auto || !unlockSecret(raw)) return;
  syncRunning = true;
  try {
    log('· 自动同步开始');
    const pull = await syncPull();
    const push = await syncPush();
    if (win && !win.isDestroyed()) {
      win.webContents.send('sync-done', { pulled: pull.pulled, pushed: push.pushed });
    }
  } catch (e) {
    log('! 自动同步失败：' + e.message);
    if (win && !win.isDestroyed()) win.webContents.send('sync-done', { error: e.message });
  } finally {
    autoLast = new Date().toISOString();
    syncRunning = false;
  }
}

// 远程用主机名给每台机器分目录，看得懂是哪台；主机名里有非法字符就换掉
function hostSlug() {
  let name = '';
  try { name = os.hostname() || ''; } catch (e) { name = ''; }
  name = name.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '');
  return name.slice(0, 48);
}

function deviceName() {
  const raw = readSyncRaw();
  const host = hostSlug();
  if (host) {
    if (raw.device !== host) {
      raw.device = host;
      writeSyncRaw(raw);
    }
    return host;
  }
  // 主机名取不到才退回随机串
  if (raw.device) return raw.device;
  raw.device = crypto.randomBytes(4).toString('hex');
  writeSyncRaw(raw);
  return raw.device;
}

// 远程布局：<目录>/<设备id>/<产品>/<档案>.bbs + <设备id>/manifest.bbs
// 每台机器只写自己那层目录，所以多台机器的备份能同时留着，不会互相盖掉。
async function syncPush() {
  const cfg = syncConfigOrThrow();
  const device = deviceName();
  await sync.testConnection(cfg);
  const base = cfg.dir + '/' + device;
  const items = [];

  for (const P of PRODUCTS) {
    const root = profilesDir(P);
    const names = await fsp.readdir(root).catch(() => []);
    for (const name of names) {
      const authDir = path.join(root, name, 'auth');
      if (!fs.existsSync(authDir)) continue;
      const meta = await readMeta(P, name);
      const files = {};
      for (const f of await fsp.readdir(authDir)) {
        const full = path.join(authDir, f);
        if (!(await fsp.stat(full)).isFile()) continue;
        files[f] = (await fsp.readFile(full)).toString('base64');
      }
      const payload = {
        v: 1,
        product: P.id,
        name,
        savedAt: (meta && meta.savedAt) || new Date().toISOString(),
        accountUid: (meta && meta.accountUid) || '',
        nickname: (meta && meta.nickname) || '',
        uin: (meta && meta.uin) || '',
        files
      };
      const buf = sync.seal(cfg.key, payload);
      await sync.put(cfg, base + '/' + P.id + '/' + name + sync.EXT, buf);
      items.push({ product: P.id, name, savedAt: payload.savedAt, bytes: buf.length });
      log('· 已上传「' + name + '」（' + P.label + '）');
    }
  }

  await sync.put(cfg, base + '/manifest' + sync.EXT, sync.seal(cfg.key, {
    v: 2,
    device,
    updatedAt: new Date().toISOString(),
    items
  }));
  log('✓ 上传完成，本机 ' + device + ' 共 ' + items.length + ' 个档案');
  return { pushed: items.length, device };
}

// 把远程所有设备的档案汇总成一张清单（同名档案会有多条，来自不同设备）
async function collectRemote(cfg) {
  const entries = [];
  const dirs = await sync.listDirs(cfg, cfg.dir).catch(() => []);

  for (const d of dirs) {
    const rel = cfg.dir + '/' + d;
    if (PRODUCTS.some((p) => p.id === d)) {
      // 早期版本直接放在 <目录>/<产品>/<档案>.bbs
      for (const f of await sync.listFiles(cfg, rel, sync.EXT).catch(() => [])) {
        entries.push({ device: '旧版', product: d, name: f.slice(0, -sync.EXT.length), savedAt: '', path: rel + '/' + f });
      }
      continue;
    }

    let manifest = null;
    try {
      const buf = await sync.get(cfg, rel + '/manifest' + sync.EXT);
      if (buf) manifest = sync.open(cfg.key, buf);
    } catch (e) { /* 别的机器可能用了另一个同步密码，跳过这一台 */ }

    if (manifest && Array.isArray(manifest.items)) {
      for (const it of manifest.items) {
        if (!it || !it.product || !it.name) continue;
        entries.push({
          device: d,
          product: it.product,
          name: it.name,
          savedAt: it.savedAt || '',
          path: rel + '/' + it.product + '/' + it.name + sync.EXT
        });
      }
      continue;
    }

    // 有目录没有 manifest：按产品目录扫一遍
    for (const P of PRODUCTS) {
      for (const f of await sync.listFiles(cfg, rel + '/' + P.id, sync.EXT).catch(() => [])) {
        entries.push({ device: d, product: P.id, name: f.slice(0, -sync.EXT.length), savedAt: '', path: rel + '/' + P.id + '/' + f });
      }
    }
  }

  return entries;
}

function pickNewest(entries) {
  const best = new Map();
  for (const e of entries) {
    const key = e.product + '/' + e.name;
    const cur = best.get(key);
    if (!cur || (e.savedAt || '') > (cur.savedAt || '')) best.set(key, e);
  }
  return best;
}

async function syncInventory() {
  const cfg = syncConfigOrThrow();
  await sync.testConnection(cfg);
  const entries = await collectRemote(cfg);
  return {
    device: hostSlug() || deviceName(),
    entries: entries.map((e) => ({
      device: e.device,
      product: e.product,
      label: (PRODUCTS.find((p) => p.id === e.product) || {}).label || e.product,
      name: e.name,
      savedAt: e.savedAt || ''
    }))
  };
}

async function syncPull() {
  const cfg = syncConfigOrThrow();
  await sync.testConnection(cfg);
  const entries = await collectRemote(cfg);
  if (!entries.length) {
    log('· 远程还没有档案');
    return { pulled: 0, skipped: 0, total: 0 };
  }

  // 同一个档案在多个设备上都有时，取 savedAt 最新那份
  const best = pickNewest(entries);
  const backupDir = path.join(BACKUP_ROOT, 'sync-' + new Date().toISOString().replace(/[:.]/g, '-'));
  let pulled = 0;
  const skipped = [];

  for (const e of best.values()) {
    const P = productById(e.product);
    if (!P || !NAME_RE.test(e.name)) continue;

    let payload;
    try {
      const buf = await sync.get(cfg, e.path);
      if (!buf) continue;
      payload = sync.open(cfg.key, buf);
    } catch (err) { skipped.push(e.name + '（' + (err.message || '读取失败') + '）'); continue; }

    const local = await readMeta(P, e.name);
    // 时间一样就是同一份快照，不用再写一遍
    if (local && local.savedAt && payload.savedAt &&
      new Date(local.savedAt).getTime() >= new Date(payload.savedAt).getTime()) {
      skipped.push(e.name + '（本地不旧）');
      continue;
    }

    const staging = path.join(PROFILES_ROOT, '.tmp', 'pull-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    await fsp.mkdir(path.join(staging, 'auth'), { recursive: true });
    for (const f of Object.keys(payload.files || {})) {
      await fsp.writeFile(path.join(staging, 'auth', f), Buffer.from(payload.files[f], 'base64'));
    }
    const stats = await dirStats(staging);

    const dest = path.join(profilesDir(P), e.name);
    await fsp.mkdir(profilesDir(P), { recursive: true });
    if (fs.existsSync(dest)) {
      // 覆盖前先留一份本地备份，出问题可以手工回滚
      const keep = path.join(backupDir, P.id, e.name);
      await fsp.mkdir(path.dirname(keep), { recursive: true });
      await retry(() => fsp.rename(dest, keep));
    }
    await retry(() => fsp.rename(staging, dest));

    await writeMeta(P, e.name, {
      name: e.name,
      savedAt: payload.savedAt || new Date().toISOString(),
      bytes: stats.bytes,
      files: stats.files,
      accountUid: payload.accountUid || '',
      nickname: payload.nickname || '',
      uin: payload.uin || '',
      appVersion: app.getVersion()
    });
    pulled++;
    log('· 已下载「' + e.name + '」（' + P.label + '，来自 ' + e.device + '）');
  }

  invalidate();
  log('✓ 拉取完成，远程共 ' + entries.length + ' 份 / 去重后 ' + best.size + ' 个档案，写入 ' + pulled + ' 个' +
    (skipped.length ? '，跳过 ' + skipped.length + ' 个' : ''));
  return { pulled, skipped: skipped.length, total: entries.length, unique: best.size };
}
// 换号/保存这些动作期间，别让自动同步插进来改档案
function guarded(fn) {
  return async function () {
    const args = Array.prototype.slice.call(arguments);
    mutating++;
    try { return await fn.apply(null, args); }
    finally { mutating--; }
  };
}

function wrap(fn) {
  return async function () {
    const args = Array.prototype.slice.call(arguments, 1);
    try {
      const r = (await fn.apply(null, args)) || {};
      return Object.assign({ ok: true }, r);
    } catch (e) {
      log('! ' + e.message);
      return { ok: false, error: e.message };
    }
  };
}

ipcMain.handle('get-status', wrap((product) => getStatus(product)));
ipcMain.handle('save-profile', wrap(guarded((product, name) => saveProfile(product, name))));
ipcMain.handle('switch-to', wrap(guarded((product, name) => switchTo(product, name))));
ipcMain.handle('delete-profile', wrap(guarded((product, name) => deleteProfile(product, name))));
ipcMain.handle('start-fresh', wrap(guarded((product) => startFresh(product))));
ipcMain.handle('open-profiles-folder', wrap(async (product) => {
  const dir = profilesDir(productById(product));
  await fsp.mkdir(dir, { recursive: true });
  await shell.openPath(dir);
  return {};
}));

ipcMain.handle('sync-get', wrap(() => syncSettings()));
ipcMain.handle('sync-save', wrap((cfg) => syncSave(cfg)));
ipcMain.handle('sync-test', wrap(async () => {
  const cfg = syncConfigOrThrow();
  await sync.testConnection(cfg);
  return {};
}));
ipcMain.handle('sync-list', wrap(() => syncInventory()));
ipcMain.handle('sync-push', wrap(() => syncPush()));
ipcMain.handle('sync-pull', wrap(() => syncPull()));

// macOS 的复制/粘贴/退出快捷键挂在菜单角色上，清空菜单会让输入框丢快捷键；
// Windows 继续不要菜单栏。
function installMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 780,
    minHeight: 620,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0f0e' : '#f7f7f5',
    title: 'Buddy-Switcher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  installMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (!app.isPackaged) watchRenderer(win);
}

function debounce(fn, ms) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

// 只在开发模式生效：改 renderer/ 下的文件，窗口自己刷新，不用重启
function watchRenderer(target) {
  if (watchRenderer.done) return;
  watchRenderer.done = true;
  const reload = debounce(() => {
    if (!target.isDestroyed()) target.webContents.reloadIgnoringCache();
  }, 120);
  try {
    fs.watch(path.join(__dirname, 'renderer'), { recursive: true }, reload);
  } catch (e) {
    log('! renderer 热刷新监听失败：' + e.message);
  }
}

// 供本地脚本在无 Electron 环境下验证快照/换入逻辑
if (process.env.BUDDY_SWITCHER_TEST) {
  module.exports = {
    PRODUCTS, snapshotTo, restoreProfile, authDir, profilesDir, migrateLayout
  };
}

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    await migrateLayout();
    // 启动时把两边的安装位置解析好，界面上"未安装"才准
    for (const p of PRODUCTS) await resolveExe(p).catch(() => {});
    createWindow();
    startAutoSync();
    // 后台轮询两个 App 的运行状态，界面只读结果，不阻塞
    for (const p of PRODUCTS) refreshAppState(p);
    setInterval(() => { for (const p of PRODUCTS) refreshAppState(p); }, 2500);
  });
  app.on('window-all-closed', () => app.quit());
}
