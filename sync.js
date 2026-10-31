'use strict';

// WebDAV 传输 + 本地加密。只管"把一段 buffer 传上去/拿下来"，档案读写留在 main.js。
const crypto = require('crypto');

const MAGIC = Buffer.from('BBS1');
const EXT = '.bbs';
const TIMEOUT = 20000;

function headers(config, extra) {
  const raw = Buffer.from(config.user + ':' + config.pass, 'utf8').toString('base64');
  return Object.assign({ Authorization: 'Basic ' + raw }, extra || {});
}

function urlFor(config, rel) {
  const base = config.url.endsWith('/') ? config.url : config.url + '/';
  const tail = rel ? rel.split('/').map(encodeURIComponent).join('/') : '';
  return base + tail;
}

async function dav(config, method, rel, body, extra) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    return await fetch(urlFor(config, rel), {
      method,
      headers: headers(config, extra),
      body,
      signal: controller.signal,
      redirect: 'follow'
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('连接超时（' + TIMEOUT / 1000 + ' 秒），检查地址和网络');
    throw new Error('连接失败：' + e.message);
  } finally {
    clearTimeout(timer);
  }
}

function statusText(res) {
  return res.status + ' ' + (res.statusText || '');
}

// 逐级建目录；已存在的返回 405/301，按成功处理
async function ensureDir(config, rel) {
  const parts = rel.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur = cur ? cur + '/' + p : p;
    const res = await dav(config, 'MKCOL', cur);
    if (res.status === 401 || res.status === 403) throw new Error('认证失败（' + statusText(res) + '），检查用户名和密码');
    if (![201, 200, 204, 301, 302, 405].includes(res.status)) {
      throw new Error('建目录失败 ' + cur + '：' + statusText(res));
    }
  }
}

async function testConnection(config) {
  await ensureDir(config, config.dir);
  const res = await dav(config, 'PROPFIND', config.dir, null, { Depth: '0' });
  if (res.status === 401 || res.status === 403) throw new Error('认证失败（' + statusText(res) + '），检查用户名和密码');
  if (res.status >= 400 && res.status !== 404) throw new Error('服务器返回 ' + statusText(res));
  return true;
}

async function put(config, rel, buf) {
  const dir = rel.split('/').slice(0, -1).join('/');
  if (dir) await ensureDir(config, dir);
  const res = await dav(config, 'PUT', rel, buf, { 'Content-Type': 'application/octet-stream' });
  if (res.status === 401 || res.status === 403) throw new Error('认证失败（' + statusText(res) + '）');
  if (res.status >= 300) throw new Error('上传失败 ' + rel + '：' + statusText(res));
}

async function get(config, rel) {
  const res = await dav(config, 'GET', rel);
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error('认证失败（' + statusText(res) + '）');
  if (res.status >= 300) throw new Error('下载失败 ' + rel + '：' + statusText(res));
  return Buffer.from(await res.arrayBuffer());
}

async function listEntries(config, rel) {
  const res = await dav(config, 'PROPFIND', rel, null, { Depth: '1' });
  if (res.status === 404) return [];
  if (res.status === 401 || res.status === 403) throw new Error('认证失败（' + statusText(res) + '）');
  if (res.status >= 300) throw new Error('列目录失败 ' + rel + '：' + statusText(res));
  const xml = await res.text();
  const out = new Map();
  const re = /<[a-zA-Z0-9]*:?href[^>]*>([^<]+)<\/[a-zA-Z0-9]*:?href>/g;
  let m;
  while ((m = re.exec(xml))) {
    let href = m[1].trim();
    try { href = decodeURIComponent(href); } catch (e) { /* 保持原样 */ }
    const isDir = href.endsWith('/');
    const parts = href.split('/').filter(Boolean);
    const name = parts.pop();
    // PROPFIND Depth:1 会把当前目录自己也列出来，跳过
    if (!name || name === (rel.split('/').filter(Boolean).pop() || '')) continue;
    out.set(name, isDir);
  }
  return [...out.entries()].map(([name, isDir]) => ({ name, isDir }));
}

async function listFiles(config, rel, ext) {
  const entries = await listEntries(config, rel);
  return entries.filter((e) => !e.isDir && e.name.endsWith(ext || EXT)).map((e) => e.name);
}

async function listDirs(config, rel) {
  const entries = await listEntries(config, rel);
  return entries.filter((e) => e.isDir).map((e) => e.name);
}

async function list(config, rel) {
  return listFiles(config, rel, EXT);
}

// ---------- 加密：scrypt 派生密钥 + AES-256-GCM，文件自带头部 ----------

function seal(passphrase, payload) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ct]);
}

function open(passphrase, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 52 || !buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error('不是 Buddy-Switcher 的同步文件');
  }
  let p = 4;
  const salt = buf.subarray(p, p + 16); p += 16;
  const iv = buf.subarray(p, p + 12); p += 12;
  const tag = buf.subarray(p, p + 16); p += 16;
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(buf.subarray(p)), decipher.final()]);
  } catch (e) {
    throw new Error('解密失败：同步密码不正确');
  }
  return JSON.parse(plain.toString('utf8'));
}

module.exports = { EXT, testConnection, ensureDir, put, get, list, listFiles, listDirs, seal, open, urlFor };
