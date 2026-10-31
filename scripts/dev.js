'use strict';
// 开发模式：直接跑源码，不打包。改 main.js / preload.js 自动重启，
// 改 renderer/ 下的文件由主进程热刷新（见 main.js watchRenderer）。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const electron = require('electron'); // 普通 node 下返回 electron.exe 路径

const env = { ...process.env };
// 有些终端（比如从某些工具里拉起的 shell）会把这两个变量带进来，导致 electron 以 node 模式启动
delete env.ELECTRON_RUN_AS_NODE;
delete env.BUDDY_SWITCHER_TEST;

let child = null;
let restarting = false;

function start() {
  console.log('[dev] 启动 Electron（改 renderer/ 自动刷新，改 main.js/preload.js 自动重启）');
  child = spawn(electron, ['.'], { cwd: root, stdio: 'inherit', env });
  child.on('exit', (code) => {
    if (restarting) return;
    process.exit(code === null ? 0 : code);
  });
}

function restart() {
  if (!child) return start();
  console.log('[dev] 主进程文件变了，重启 ...');
  restarting = true;
  child.once('exit', () => { restarting = false; start(); });
  child.kill();
}

let timer = null;
for (const file of ['main.js', 'preload.js']) {
  fs.watch(path.join(root, file), () => {
    clearTimeout(timer);
    timer = setTimeout(restart, 150);
  });
}

start();
