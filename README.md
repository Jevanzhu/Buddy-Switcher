# Buddy-Switcher — CodeBuddy / WorkBuddy 多账号切换器

Windows 桌面小工具：在多个账号之间一键切换，不用反复登出登录。
支持 **CodeBuddy Desktop**（含内置 CLI）和 **WorkBuddy**，两者各自独立切。

## 凭据到底存在哪

登录态不按整个应用目录保存，而是单独一个会话文件，两个 App 放在同一个目录里：

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\
    Tencent-Cloud.coding-copilot.info        <- CodeBuddy CLI + Desktop 共用
    workbuddy-desktop.info                   <- WorkBuddy
```

CodeBuddy 的 `.info` 是明文 JSON：

```json
{ "account": { "uid": "...", "nickname": "...", "uin": "..." },
  "auth": { "accessToken": "...", "refreshToken": "...", "expiresAt": 0 } }
```

WorkBuddy 把 `nickname`、`accessToken` 包成了 `{ "$wbEncrypted": 1, "envelope": "..." }`
（AES 信封，密钥在 `~/.workbuddy/keyblob` 里，由内置静态密钥再包一层），所以只能读到
`uid` 和 `uin`。界面上的昵称是按 `uid` 去同目录其它产品的明文 `nickname` 里借的，借不到就显示 `uin`。

桌面端内置的 CLI daemon 也是从 `<sharedDataPath>/auth/<产品id>.info` 读它
（`FilePathService.getAuthSavePath()`，win32 的 basePath 就是
`%LOCALAPPDATA%\CodeBuddyExtension`）。所以换掉对应文件，该 App 的账号就换了。

`%APPDATA%\CodeBuddy Desktop` 里只有渲染层的 sessionToken、cookie、缓存，
没有账号身份——复制它并不能换号。

两个 App 的会话互不干扰：切 CodeBuddy 不会动 WorkBuddy 的登录。

## 档案结构

```
~/.buddy-switcher/
    profiles/codebuddy/<档案名>/auth/*.info   # CodeBuddy 的账号文件
    profiles/workbuddy/<档案名>/auth/*.info   # WorkBuddy 的账号文件
    .meta/<产品>/<档案名>.json                # 保存时间、大小、uid、昵称
    .backup/                                 # 覆盖保存的旧档案、新建账号时移出的旧会话
    logs/YYYY-MM-DD.log                      # 操作日志
    CURRENT-<产品>                            # 各产品当前档案名
    launcher.json                            # 记住的主程序路径（按产品）
    sync.json                                # WebDAV 同步配置（密码走系统安全存储）
```

档案只存登录会话文件，每个几十 KB。早期版本直接放在根目录的档案，首次启动时会自动归位。

## 跨设备同步（WebDAV）

右上角「跨设备同步」里填服务器地址、账号密码、远程目录，可以顺手打开**自动同步**（每 5 / 15 / 30 / 60 分钟一次）。

档案用 **WebDAV 密码**派生密钥加密，不额外设同步密码——少记一个东西，代价是改 WebDAV 密码后旧密文解不开。

- 上传：每个档案打包成一份 `.bbs`，用同步密码 scrypt 派生密钥 + AES-256-GCM 加密后 PUT 上去，
  服务器上只有密文；同一账号在另一台机器上填相同同步密码就能拉下来。
- **远程按机器分区**：`<远程目录>/<主机名>/<产品>/<档案名>.bbs`（例如 `dev-machine/`），每台机器只写自己那层目录，
  所以两台机器同时上传也不会互相覆盖，各自的备份都留着。
- **冲突处理**：拉取时把所有设备的清单汇总，同一个档案在多台机器上都有时按 `savedAt` 取最新那份；
  本地那份不比远程旧就跳过，不重写。覆盖本地之前会先备份到 `.backup/sync-<时间>/`，可以手工回滚。
- 弹窗里的「远程档案」列表就是远程现在有哪些机器的哪些档案，方便拉之前先看一眼。
- **自动同步**：纯粹按周期跑，每 N 分钟一轮，每轮「先拉后传」——
  拉取保证拿到别的机器的档案，再上传让本机的档案也进远程。换号/保存进行中会跳过这一轮，不会打断操作。
- **点「保存配置」不会同步**：保存只写配置并开始计时，不会顺手传一次；启动程序也一样，
  第一轮要等到 N 分钟之后。想立刻同步就按「从远程拉取 / 上传本机档案」。
  计时从「开启」那一刻起算，中途保存/测试/手动上传都**不会**重置倒计时；弹窗里会直接显示
  「上次 21:13 · 下次 21:17（4 分 51 秒后）」，倒计时逐秒走，时间到底生效没有一眼就能看出来。

举例：A 机器上有 2 个档案、B 机器上有 1 个，各自的档案名不重名时，两边各同步一次后都会变成 3 个
（A 上传 → B 拉取拿到 3 个 → B 上传 → A 拉取也变 3 个）。如果两边有同名档案，会被当成同一个，
按 `savedAt` 取最新那份，不会变成 4 个。
- WebDAV 密码用 Electron `safeStorage`（Windows DPAPI）加密后存本地，`sync.json` 里看不到明文。

WebDAV 密码换了以后，旧密文就解不开了——远程的旧备份需要重新上传一遍。

## 切换流程

1. 弹窗确认（显示要切到哪个档案）
2. 退出对应的 App —— 内置 daemon 是它的子进程，一起结束；3 秒内没退出就强制结束
3. 把当前会话回存到当前档案
4. 备份现有会话文件 → 换入目标档案（失败自动回滚）
5. 重新启动该 App

## 使用

顶部可以切换 **CodeBuddy / WorkBuddy**，选哪个就管哪个的档案。

1. 在 App 里登录账号 A，切到对应标签，输入名字（如「工作」）→ 保存为档案。
2. 点右上角「新建账号」，清空当前登录并重启，登录 B 后再保存一份。
3. 之后点档案卡片上的「切换」即可一键换号。

**不要用 App 自带的「退出登录」**——登出会让服务端吊销 token，已保存的档案就作废了。
用「新建账号」代替，它只是把本地会话文件移走。

## 注意

- 切换会让对应 App 退出并重启，正在进行的会话会中断。
- 档案里是完整的 accessToken / refreshToken，**不要分享、不要同步到公共网盘**。
- 未做代码签名，Windows SmartScreen 提示时点「更多信息 → 仍要运行」。
- 主程序不在常见目录（例如装在 D 盘）时会弹窗让你手动指定一次，之后会记住。
- 同一时间只允许运行一个切换器实例。
- 没装的 App 仍然可以选，但保存/切换时会提示找不到主程序。

## 构建（Windows 单文件免安装版）

```bash
npm install
npm run dist:win
```

产物：`dist/Buddy-Switcher-<版本>-portable.exe`，双击即用，无需安装。

生成图标（已随仓库提供，图标改样时重跑）：

```bash
npm run icon
```

## 开发调试

改样式、调界面时不用打包，直接跑源码：

```bash
npm start      # 等同 npm run dev
```

- 改 `renderer/` 下的任何文件（html / css / js）→ 窗口自动刷新，约 0.1 秒
- 改 `main.js` / `preload.js` → 自动重启 Electron
- 只有真要发版本时才 `npm run dist:win`

`scripts/dev.js` 会主动清掉 `ELECTRON_RUN_AS_NODE`，所以从任何终端启动都不会踩到
“主进程按纯 Node 跑”的坑。

### 打包体积

便携版从 110 MB 压到 **95 MB**，靠的是三条（都在 `electron-builder.yml` / `scripts/after-pack.js`）：

- `electronLanguages` 只留 `zh-CN` / `en-US`，其余 53 个语言包直接不进包（-48 MB 解包体积）
- `afterPack` 删掉 `dxcompiler.dll` / `vk_swiftshader.dll` / `vulkan-1.dll`（-30 MB）——
  这些是 WebGPU / Vulkan 软件回退用的，界面纯 HTML/CSS，不需要
- `compression: maximum`

再往下就得换运行时了：剩下 ~85 MB 全是 Electron 本体（Chromium + V8），
想做到个位数 MB 只能改 WebView2 / Tauri 这类用系统浏览器的方案，等于重写外壳。

### 自动化测试别碰真实数据

程序用 `BUDDY_SWITCHER_HOME` 指定配置根目录，默认是 `~/.buddy-switcher`。写脚本驱动界面
（CDP 之类）时把它指向临时目录，档案、`sync.json`、日志就都落在那边：

    BUDDY_SWITCHER_HOME=/tmp/bs-test electron .

这样测试跑完删临时目录即可，真实的 WebDAV 地址、密码和档案一份都不会动。
