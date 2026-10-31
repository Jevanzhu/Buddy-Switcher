'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');

const TARGET_APP_NAME = 'CodeBuddy Desktop';
const TARGET_EXE = 'CodeBuddy Desktop.exe';
const PROFILES_ROOT = path.join(os.homedir(), '.codebuddy-profiles');
const CURRENT_FILE = path.join(PROFILES_ROOT, 'CURRENT');
const LAUNCHER_FILE = path.join(PROFILES_ROOT, 'launcher.json');
const NAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,32}$/;

// 顶层缓存目录（体积大且可再生，不进档案）
const SKIP_TOP_DIRS = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'blob_storage']);
// 单实例锁文件（与运行中的进程绑定，复制无意义）
const SKIP_BASENAMES = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']);

let win = null;

function log(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('app-log', msg);
  console.log(msg);
}

function execP(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) =>
      resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function targetDataDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'CodeBuddy Desktop');
  }
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appdata, 'CodeBuddy Desktop');
  }
  return path.join(home, '.config', 'CodeBuddy Desktop');
}

async function isTargetRunning() {
  if (process.platform === 'darwin') {
    const r = await execP('pgrep', ['-f', 'CodeBuddy Desktop.app/Contents/MacOS']);
    return r.err === null;
  }
  if (process.platform === 'win32') {
    const r = await execP('tasklist', ['/FI', 'IMAGENAME eq ' + TARGET_EXE, '/FO', 'CSV', '/NH']);
    return r.stdout.toLowerCase().includes(TARGET_EXE.toLowerCase());
  }
  return false;
}

async function quitTarget() {
  if (!(await isTargetRunning())) return;
  log('→ 正在退出 ' + TARGET_APP_NAME + ' ...');
  if (process.platform === 'darwin') {
    await execP('osascript', ['-e', 'quit app "CodeBuddy Desktop"']);
    for (let i = 0; i < 40; i++) {
      if (!(await isTargetRunning())) return;
      await sleep(500);
    }
  } else {
    await execP('taskkill', ['/IM', TARGET_EXE]);
    for (let i = 0; i < 30; i++) {
      if (!(await isTargetRunning())) return;
      await sleep(500);
    }
    log('→ 未能优雅退出，尝试强制结束 ...');
    await execP('taskkill', ['/F', '/IM', TARGET_EXE]);
    for (let i = 0; i < 20; i++) {
      if (!(await isTargetRunning())) return;
      await sleep(500);
    }
  }
  throw new Error(TARGET_APP_NAME + ' 未能退出，已取消操作（请手动退出后重试）');
}

async function readLauncherPath() {
  try { return JSON.parse(await fsp.readFile(LAUNCHER_FILE, 'utf8')).exePath || ''; }
  catch (e) { return ''; }
}

async function writeLauncherPath(exePath) {
  await fsp.mkdir(PROFILES_ROOT, { recursive: true });
  await fsp.writeFile(LAUNCHER_FILE, JSON.stringify({ exePath }, null, 2), 'utf8');
}

async function resolveWindowsExe() {
  const cached = await readLauncherPath();
  if (cached && fs.existsSync(cached)) return cached;
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  candidates.push(path.join(localAppData, 'Programs', TARGET_APP_NAME, TARGET_EXE));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, TARGET_APP_NAME, TARGET_EXE));
  if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], TARGET_APP_NAME, TARGET_EXE));
  for (const root of ['HKCU', 'HKLM']) {
    const r = await execP('reg', ['query', root + '\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + TARGET_EXE, '/ve']);
    const m = r.stdout.match(/REG_SZ\s+(.+\.exe)/i);
    if (m) candidates.push(m[1].trim());
  }
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return '';
}

function makeFilter(srcRoot) {
  return (s) => {
    if (s === srcRoot) return true;
    const rel = path.relative(srcRoot, s);
    const parts = rel.split(path.sep);
    if (parts.length === 1 && SKIP_TOP_DIRS.has(parts[0])) return false;
    if (SKIP_BASENAMES.has(parts[parts.length - 1])) return false;
    return true;
  };
}

async function copyDir(from, to, label) {
  log('→ 复制档案数据（' + label + '）...');
  await fsp.mkdir(to, { recursive: true });
  await fsp.cp(from, to, { recursive: true, force: true, filter: makeFilter(from) });
}

async function readCurrent() {
  try { return (await fsp.readFile(CURRENT_FILE, 'utf8')).trim(); }
  catch (e) { return ''; }
}

async function writeCurrent(name) {
  await fsp.mkdir(PROFILES_ROOT, { recursive: true });
  await fsp.writeFile(CURRENT_FILE, name, 'utf8');
}

async function listProfiles() {
  try {
    const entries = await fsp.readdir(PROFILES_ROOT, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (e) { return []; }
}

function validateName(name) {
  if (!NAME_RE.test(name)) throw new Error('档案名只能包含中文、字母、数字、_ 或 -，长度 1-32');
}

async function saveCurrentToProfile(name) {
  const dataDir = targetDataDir();
  if (!fs.existsSync(dataDir)) throw new Error('未找到 CodeBuddy Desktop 数据目录：' + dataDir);
  await copyDir(dataDir, path.join(PROFILES_ROOT, name), name);
}

async function restoreProfile(name) {
  const src = path.join(PROFILES_ROOT, name);
  const dataDir = targetDataDir();
  if (!fs.existsSync(src)) throw new Error('档案不存在：' + name);
  if (fs.existsSync(dataDir)) {
    log('→ 清空当前数据目录 ...');
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
  await copyDir(src, dataDir, name);
}

async function getStatus() {
  const current = await readCurrent();
  const profiles = await listProfiles();
  const running = await isTargetRunning();
  return {
    platform: process.platform,
    current: current,
    profiles: profiles,
    appRunning: running,
    dataDir: targetDataDir(),
    dataDirExists: fs.existsSync(targetDataDir())
  };
}

async function saveProfile(name) {
  validateName(name);
  await quitTarget();
  await saveCurrentToProfile(name);
  await writeCurrent(name);
  await launchTarget();
  log('OK 当前登录态已保存为档案 [' + name + ']');
  return { saved: name };
}

async function switchTo(name) {
  validateName(name);
  const profileDir = path.join(PROFILES_ROOT, name);
  if (!fs.existsSync(profileDir)) throw new Error('档案不存在：' + name);
  const prev = await readCurrent();
  await quitTarget();
  if (prev && prev !== name && fs.existsSync(path.join(PROFILES_ROOT, prev)) && fs.existsSync(targetDataDir())) {
    try { await saveCurrentToProfile(prev); log('OK 原档案 [' + prev + '] 已回存'); }
    catch (e) { log('! 原档案回存失败：' + e.message); }
  }
  await restoreProfile(name);
  await writeCurrent(name);
  await launchTarget();
  log('OK 已切换到档案 [' + name + ']');
  return { switched: name };
}

async function deleteProfile(name) {
  validateName(name);
  const dir = path.join(PROFILES_ROOT, name);
  if (!fs.existsSync(dir)) throw new Error('档案不存在：' + name);
  await fsp.rm(dir, { recursive: true, force: true });
  if ((await readCurrent()) === name) await fsp.rm(CURRENT_FILE, { force: true });
  log('OK 已删除档案 [' + name + ']');
  return { deleted: name };
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

ipcMain.handle('get-status', wrap(() => getStatus()));
ipcMain.handle('save-profile', wrap((name) => saveProfile(name)));
ipcMain.handle('switch-to', wrap((name) => switchTo(name)));
ipcMain.handle('delete-profile', wrap((name) => deleteProfile(name)));
ipcMain.handle('open-profiles-folder', wrap(async () => {
  await fsp.mkdir(PROFILES_ROOT, { recursive: true });
  shell.openPath(PROFILES_ROOT);
  return {};
}));

function createWindow() {
  win = new BrowserWindow({
    width: 760, height: 640, minWidth: 620, minHeight: 520,
    title: 'Buddy-Switcher — CodeBuddy 账号切换器',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}