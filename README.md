# Buddy-Switcher — CodeBuddy Desktop 多账号切换器

一个跨平台（Windows / macOS）小工具，用于在多个 CodeBuddy Desktop 账号之间一键切换。

## 原理

CodeBuddy Desktop 的登录态保存在应用数据目录中：

- macOS: ~/Library/Application Support/CodeBuddy Desktop
- Windows: %APPDATA%\CodeBuddy Desktop

本工具把这些目录整体存为"账号档案"（保存在 ~/.codebuddy-profiles/<档案名>），
切换时：退出 CodeBuddy Desktop → 回存当前档案 → 换入目标档案 → 重新启动。

复制时会跳过缓存目录（Cache / GPUCache 等，可再生）和单实例锁文件，档案体积小、切换快。

## 首次使用（三步）

1. 在 CodeBuddy Desktop 登录账号 A，打开本工具，输入名字（如"工作"）→ 保存为档案。
2. 在 CodeBuddy Desktop 退出登录，改登账号 B，再保存为档案（如"个人"）。
3. 之后点档案卡片上的「切换」即可一键换号，无需重复登录。

## 注意

- 切换会让 CodeBuddy Desktop 退出并重启，其中正在进行的会话会中断。
- 未做代码签名：macOS 首次打开需右键 → 打开，或执行 xattr -cr "Buddy-Switcher.app"；
  Windows 如遇 SmartScreen 拦截，点"仍要运行"。
- Windows 上若工具找不到 CodeBuddy Desktop 主程序，会弹出选择框让你手动指定一次（之后会记住）。
- 档案目录与之前命令行版脚本 cb-switch（~/.codebuddy-profiles）兼容，可并用。

## 本地构建

    npm install
    ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx electron-builder --mac
    ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx electron-builder --win zip --x64

NSIS 安装包请在 Windows 上或 GitHub Actions 构建（Apple Silicon 缺 Rosetta 时 makensis 无法运行）：

    npx electron-builder --win    # portable + nsis

## 云端构建

推送到 GitHub 后手动触发 .github/workflows/build.yml（workflow_dispatch），
会在 macos-latest / windows-latest 上分别产出 DMG 和 NSIS/Portable 安装包。

## 开发调试

    npx electron .

注意：若 shell 里有 ELECTRON_RUN_AS_NODE=1 需先 unset，否则主进程会按纯 Node 启动报错。
