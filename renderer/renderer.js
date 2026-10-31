'use strict';

const $ = (id) => document.getElementById(id);
let busy = false;
// 每个产品上次拿到的状态：切标签时先上屏再刷新，点下去立刻有反馈
const cache = new Map();

function readPref(key) {
  try { return window.localStorage.getItem(key) || ''; } catch (e) { return ''; }
}

function writePref(key, value) {
  try { window.localStorage.setItem(key, value); } catch (e) { /* 忽略 */ }
}

let activeProduct = readPref('buddy.product') || 'codebuddy';

const STATE_TEXT = {
  running: '运行中',
  stopped: '未运行',
  unknown: '状态未知'
};

function icon(name) {
  return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
}

function hueFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function fmtBytes(n) {
  if (!n) return '';
  const mb = n / 1048576;
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function appendLog(msg) {
  const box = $('log');
  const kind = msg.startsWith('✓') ? 'ok'
    : msg.startsWith('!') ? 'err'
      : msg.startsWith('·') ? 'info' : 'step';

  const line = document.createElement('div');
  line.className = 'log-line l-' + kind;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  const text = document.createElement('span');
  text.textContent = msg;

  line.append(time, text);
  box.appendChild(line);

  while (box.children.length > 200) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function setBusy(on) {
  busy = on;
  document.body.classList.toggle('busy', on);
  $('busy-bar').classList.toggle('on', on);
  document.querySelectorAll('button').forEach((btn) => { btn.disabled = on; });
}

function setAppState(appState) {
  const chip = $('app-state');
  chip.dataset.state = appState || 'unknown';
  $('app-state-text').textContent = STATE_TEXT[appState] || STATE_TEXT.unknown;
}

function paintSeg() {
  document.querySelectorAll('#product-switch button').forEach((btn) => {
    btn.setAttribute('aria-selected', btn.dataset.id === activeProduct ? 'true' : 'false');
  });
}

function selectProduct(id) {
  if (id === activeProduct) return;
  activeProduct = id;
  writePref('buddy.product', id);
  paintSeg();
  const cached = cache.get(id);
  if (cached) render(cached);
  refresh(id);
}

function renderSeg(products) {
  const box = $('product-switch');
  const signature = products.map((p) => p.id + p.label + p.installed).join('|');
  if (box.dataset.signature !== signature) {
    box.dataset.signature = signature;
    box.replaceChildren();
    products.forEach((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.id = p.id;
      btn.setAttribute('role', 'tab');
      btn.textContent = p.label;
      if (!p.installed) btn.title = '未检测到 ' + p.appName + ' 的安装位置';
      btn.addEventListener('click', () => selectProduct(p.id));
      box.appendChild(btn);
    });
  }
  paintSeg();
}

function whoText(p) {
  if (p.nickname) return p.nickname;
  if (p.uin) return p.uin;
  if (p.accountUid) return p.accountUid.slice(0, 8);
  return '';
}

function buildProfile(p, isCurrent) {
  const card = document.createElement('article');
  card.className = 'profile' + (isCurrent ? ' current' : '');
  card.style.setProperty('--h', hueFor(p.name));
  if (isCurrent) card.setAttribute('aria-current', 'true');

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = p.name.slice(0, 1).toUpperCase();

  const main = document.createElement('div');
  main.className = 'profile-main';

  const line = document.createElement('div');
  line.className = 'profile-line';

  const name = document.createElement('h3');
  name.textContent = p.name;
  line.appendChild(name);

  const who = whoText(p);
  if (who) {
    const span = document.createElement('span');
    span.className = 'who';
    span.textContent = who;
    span.title = who;
    line.appendChild(span);
  }

  if (!p.hasSession) {
    const warn = document.createElement('span');
    warn.className = 'who warn';
    warn.textContent = '会话缺失';
    warn.title = '该档案缺少登录会话文件，请重新保存一次';
    line.appendChild(warn);
  }

  const meta = document.createElement('p');
  meta.className = 'profile-meta';
  const bits = [];
  if (p.savedAt) bits.push(fmtDate(p.savedAt));
  if (p.bytes) bits.push(fmtBytes(p.bytes));
  meta.textContent = bits.join(' · ') || '尚未记录保存信息';

  main.append(line, meta);

  const actions = document.createElement('div');
  actions.className = 'profile-actions';

  if (isCurrent) {
    const label = document.createElement('span');
    label.className = 'in-use';
    label.textContent = '使用中';
    actions.appendChild(label);
  } else {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn small';
    btn.innerHTML = icon('switch');
    btn.append('切换');
    btn.addEventListener('click', () => doAction(() => window.api.switchTo(activeProduct, p.name)));
    actions.appendChild(btn);
  }

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn danger';
  del.title = '删除档案';
  del.setAttribute('aria-label', '删除档案 ' + p.name);
  del.innerHTML = icon('trash');
  del.addEventListener('click', () => doAction(() => window.api.deleteProfile(activeProduct, p.name)));
  actions.appendChild(del);

  card.append(avatar, main, actions);
  return card;
}

function render(state) {
  if (!state || state.product !== activeProduct) return;

  $('version').textContent = 'v' + state.version;
  $('profiles-root').textContent = state.profilesRoot;
  $('profiles-root').title = state.profilesRoot;

  renderSeg(state.products || []);
  setAppState(state.appState);

  const active = (state.products || []).find((p) => p.id === state.product);
  const appName = active ? active.appName : 'CodeBuddy Desktop';
  document.querySelectorAll('[data-app]').forEach((el) => { el.textContent = appName; });

  const profiles = state.profiles || [];
  const list = $('profile-list');
  const frag = document.createDocumentFragment();
  profiles.forEach((p) => {
    const isCurrent = state.current && p.name.toLowerCase() === String(state.current).toLowerCase();
    frag.appendChild(buildProfile(p, isCurrent));
  });
  list.replaceChildren(frag);

  $('empty-state').hidden = profiles.length > 0;
  $('accounts-sub').textContent = profiles.length ? profiles.length + ' 个' : '';
}

async function refresh(product) {
  const id = product || activeProduct;
  try {
    const r = await window.api.getStatus(id);
    if (!r || r.ok === false) return;
    cache.set(id, r);
    if (id === activeProduct) render(r);
  } catch (e) {
    // 瞬时失败（例如正在重启）不打扰用户
  }
}

async function doAction(fn) {
  if (busy) return null;
  setBusy(true);
  let result = null;
  try {
    result = await fn();
    if (result && result.ok !== false && result.cancelled) appendLog('· 已取消操作');
  } catch (e) {
    appendLog('! ' + (e && e.message ? e.message : String(e)));
  } finally {
    cache.clear();
    setBusy(false);
    refresh(activeProduct);
  }
  return result;
}

$('refresh').addEventListener('click', () => { cache.clear(); refresh(activeProduct); });
$('clear-log').addEventListener('click', () => $('log').replaceChildren());
$('open-folder').addEventListener('click', () => window.api.openProfilesFolder(activeProduct));
$('new-account').addEventListener('click', () => doAction(() => window.api.startFresh(activeProduct)));

$('save-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('new-name');
  const name = input.value.trim();
  if (!name) {
    appendLog('! 请先输入档案名');
    input.focus();
    return;
  }
  const result = await doAction(() => window.api.saveProfile(activeProduct, name));
  if (result && result.ok && !result.cancelled) input.value = '';
  input.focus();
});

// 主进程后台轮询运行状态，变了才通知，界面不再自己定时拉
window.api.onStatus((payload) => {
  const cached = cache.get(payload.product);
  if (cached) cached.appState = payload.appState;
  if (payload.product === activeProduct) setAppState(payload.appState);
});

// 自动同步完成后刷新列表，并顺手更新副标题
window.api.onSyncDone((payload) => {
  cache.clear();
  refresh(activeProduct);
  if (!payload || payload.error) return;
  if (payload.pulled || payload.pushed) {
    appendLog('✓ 自动同步：拉取 ' + payload.pulled + ' 个，上传 ' + payload.pushed + ' 个');
  }
  if (!$('sync-modal').hidden) window.api.syncGet().then(paintTimer).catch(() => {});
});

window.addEventListener('focus', () => { cache.clear(); refresh(activeProduct); });

// ---------- 跨设备同步（WebDAV） ----------

function syncForm() {
  return {
    url: $('sync-url').value.trim(),
    user: $('sync-user').value.trim(),
    pass: $('sync-pass').value,
    dir: $('sync-dir').value.trim(),
    auto: $('sync-auto').checked,
    every: Number($('sync-every').value) || 15
  };
}

// 自动同步的"上次/下次"——用户最关心的就是这个时间到底有没有走
let timerState = { auto: false, lastAt: '', nextAt: '' };
let timerTick = null;

function fmtClock(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function paintTimer(s) {
  if (s) timerState = { auto: !!s.auto, lastAt: s.lastAt || '', nextAt: s.nextAt || '' };
  const el = $('sync-timer');
  if (!el) return;
  if (!timerState.auto) {
    el.textContent = '自动同步已关闭';
    el.dataset.kind = '';
    return;
  }
  const last = fmtClock(timerState.lastAt);
  const next = fmtClock(timerState.nextAt);
  const left = timerState.nextAt ? Math.round((new Date(timerState.nextAt).getTime() - Date.now()) / 1000) : -1;
  const parts = [];
  if (last) parts.push('上次 ' + last);
  if (next) {
    const rel = left >= 60
      ? Math.floor(left / 60) + ' 分 ' + String(left % 60).padStart(2, '0') + ' 秒后'
      : left > 0 ? left + ' 秒后' : '即将执行';
    parts.push('下次 ' + next + '（' + rel + '）');
  }
  el.textContent = parts.length ? parts.join(' · ') : '等待计时启动';
  el.dataset.kind = 'ok';
}

function startTimerTick() {
  stopTimerTick();
  timerTick = setInterval(() => paintTimer(), 1000);
}

function stopTimerTick() {
  if (timerTick) clearInterval(timerTick);
  timerTick = null;
}

function closeSync() {
  stopTimerTick();
  $('sync-modal').hidden = true;
}

function paintRemote(entries) {
  const box = $('sync-remote');
  box.replaceChildren();
  if (!entries.length) {
    box.textContent = '远程还没有档案';
    return;
  }
  entries.slice().sort((a, b) => (a.device + a.name).localeCompare(b.device + b.name)).forEach((e) => {
    const row = document.createElement('div');
    row.className = 'remote-row';

    const dev = document.createElement('span');
    dev.className = 'remote-dev';
    dev.textContent = e.device;
    dev.title = e.device;

    const name = document.createElement('span');
    name.className = 'remote-name';
    name.textContent = e.label + ' · ' + e.name;

    const time = document.createElement('span');
    time.className = 'remote-time';
    time.textContent = e.savedAt ? fmtDate(e.savedAt) : '';

    row.append(dev, name, time);
    box.appendChild(row);
  });
}

async function loadRemote() {
  const box = $('sync-remote');
  box.textContent = '读取中…';
  try {
    const r = await window.api.syncList();
    if (!r || r.ok === false) {
      box.textContent = (r && r.error) || '读取远程失败';
      return;
    }
    if (r.device) $('sync-device').textContent = '本机 ' + r.device + '（上传到以主机名命名的目录）';
    paintRemote(r.entries || []);
  } catch (e) {
    box.textContent = (e && e.message) || '读取远程失败';
  }
}

async function openSync() {
  const s = await window.api.syncGet();
  if (s && s.ok !== false) {
    $('sync-url').value = s.url || '';
    $('sync-user').value = s.user || '';
    $('sync-dir').value = s.dir || 'buddy-switcher';
  }
  $('sync-auto').checked = !!(s && s.auto);
  const sel = $('sync-every');
  const every = String((s && s.every) || 15);
  if (!Array.prototype.some.call(sel.options, (o) => o.value === every)) sel.add(new Option('每 ' + every + ' 分钟', every));
  sel.value = every;
  $('sync-pass').value = '';
  const status = $('sync-status');
  status.textContent = '';
  status.dataset.kind = '';
  $('sync-device').textContent = '';
  $('sync-remote').textContent = '未连接';
  $('sync-modal').hidden = false;
  paintTimer(s);
  startTimerTick();
  $('sync-url').focus();
  if (s && s.hasSecret) loadRemote();
}

async function syncRun(label, fn) {
  if (busy) return;
  const status = $('sync-status');
  status.dataset.kind = '';
  status.textContent = label + '…';
  setBusy(true);
  try {
    const saved = await window.api.syncSave(syncForm());
    if (!saved || saved.ok === false) throw new Error((saved && saved.error) || '保存配置失败');
    paintTimer(saved);
    const r = await fn();
    if (r && r.ok === false) throw new Error(r.error || '操作失败');
    status.dataset.kind = 'ok';
    status.textContent = (r && r.message) || '完成';
    $('sync-pass').value = '';
  } catch (e) {
    status.dataset.kind = 'err';
    status.textContent = (e && e.message) || String(e);
  } finally {
    setBusy(false);
    cache.clear();
    refresh(activeProduct);
    if (status.dataset.kind === 'ok' && !$('sync-modal').hidden) loadRemote();
  }
}

$('open-sync').addEventListener('click', openSync);
$('sync-close').addEventListener('click', closeSync);
$('sync-modal').addEventListener('click', (e) => { if (e.target === $('sync-modal')) closeSync(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('sync-modal').hidden) closeSync();
});

$('sync-refresh').addEventListener('click', loadRemote);

$('sync-test').addEventListener('click', () => syncRun('测试连接', async () => {
  const r = await window.api.syncTest();
  if (r && r.ok === false) return r;
  return { message: '连接成功' };
}));

$('sync-save').addEventListener('click', () => syncRun('保存', async () => ({ message: '配置已保存' })));

$('sync-push').addEventListener('click', () => syncRun('上传中', async () => {
  const r = await window.api.syncPush();
  if (r && r.ok === false) return r;
  return { message: '已上传 ' + r.pushed + ' 个档案' };
}));

$('sync-pull').addEventListener('click', () => syncRun('拉取中', async () => {
  const r = await window.api.syncPull();
  if (r && r.ok === false) return r;
  return { message: '已拉取 ' + r.pulled + ' 个档案' + (r.skipped ? '，跳过 ' + r.skipped + ' 个（本地更新）' : '') };
}));

refresh(activeProduct);
