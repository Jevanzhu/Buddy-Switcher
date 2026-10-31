'use strict';

const el = (id) => document.getElementById(id);
let busy = false;

function appendLog(msg) {
  const box = el('log');
  const line = document.createElement('div');
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function setBusy(b) {
  busy = b;
  document.querySelectorAll('button').forEach((btn) => { btn.disabled = b; });
}

async function refresh() {
  const r = await window.api.getStatus();
  if (!r.ok) { appendLog('获取状态失败: ' + r.error); return; }
  el('current-profile').textContent = r.current || '(未建档)';
  const st = el('app-state');
  st.textContent = r.appRunning ? '运行中' : '未运行';
  st.style.color = r.appRunning ? 'var(--ok)' : 'var(--muted)';
  el('data-dir').textContent = '数据目录: ' + r.dataDir;

  const list = el('profile-list');
  list.innerHTML = '';
  el('profiles-hint').style.display = r.profiles.length ? 'none' : 'block';
  for (const name of r.profiles) {
    const item = document.createElement('div');
    item.className = 'profile-item' + (name === r.current ? ' current' : '');

    const left = document.createElement('div');
    left.className = 'profile-name';
    left.textContent = name;
    if (name === r.current) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '当前';
      left.appendChild(badge);
    }

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '6px';

    const btnSwitch = document.createElement('button');
    btnSwitch.className = 'small';
    btnSwitch.textContent = name === r.current ? '当前使用' : '切换';
    btnSwitch.disabled = name === r.current;
    btnSwitch.addEventListener('click', () => doAction(() => window.api.switchTo(name), '切换到 [' + name + ']'));

    const btnDel = document.createElement('button');
    btnDel.className = 'small danger-ghost';
    btnDel.textContent = '删除';
    btnDel.addEventListener('click', async () => {
      if (!confirm('确定删除档案「' + name + '」？该账号登录态将被清除（可重新保存恢复）。')) return;
      await doAction(() => window.api.deleteProfile(name), '删除档案 [' + name + ']');
    });

    right.appendChild(btnSwitch);
    right.appendChild(btnDel);
    item.appendChild(left);
    item.appendChild(right);
    list.appendChild(item);
  }
}

async function doAction(fn, desc) {
  if (busy) return;
  setBusy(true);
  appendLog('→ ' + desc + ' ...');
  try {
    const r = await fn();
    if (!r.ok) appendLog('! 失败: ' + (r.error || '未知错误'));
  } finally {
    setBusy(false);
    await refresh();
  }
}

el('refresh').addEventListener('click', refresh);

el('save-new').addEventListener('click', async () => {
  const name = el('new-name').value.trim();
  if (!name) { appendLog('! 请先输入档案名'); return; }
  await doAction(() => window.api.saveProfile(name), '保存当前账号为档案 [' + name + ']');
  el('new-name').value = '';
});

el('open-folder').addEventListener('click', () => window.api.openProfilesFolder());

window.api.onLog((msg) => appendLog(msg));
refresh();