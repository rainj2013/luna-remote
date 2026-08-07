# Luna Remote

我想要一个打开就能干活的远程工具。服务器按组放好，点一下进入终端，要传文件就切到旁边的 SFTP，临时开个端口转发也不用再找另一款软件。

我把这些需求收进一个应用，名字叫 Luna Remote。它目前可以运行在 macOS 和 Windows 上，SSH 终端、SFTP、端口转发、连接管理和 AI 命令助手都放在同一个窗口里。

[下载最新版本](https://github.com/rainj2013/luna-remote/releases/latest)

![Luna Remote 终端界面](docs/images/terminal.png)

## 打开连接，直接干活

终端是这里的主角。你可以用密码、键盘交互、私钥或 SSH Agent 登录，应用会处理 Host Key 校验、会话保活，也支持通过一级跳板机连接目标服务器。

连接可以分组、排序和折叠。同一台机器需要同时跑几件事时，继续开新会话就行。字体、字号、配色、透明度和背景图都能调整，深色与浅色界面也可以跟着系统切换。

## 传文件时，不必离开当前窗口

本地目录和远程目录并排显示，上传、下载、预览和拖放都在这一个页面完成。目录传输、路径收藏、传输队列、失败重试和冲突处理也都在。

如果你经常把本地项目传到服务器，可以先比较两边的目录差异，再批量上传有变化的内容。

![Luna Remote SFTP 文件传输界面](docs/images/sftp.png)

## AI 可以帮忙，最后由你确认

有些命令不难，只是参数很难记。把要做的事写给 AI 命令助手，它可以生成 Linux Shell、PowerShell、CMD 或 macOS 命令，同时说明用途、前提和风险。

生成结果可以复制，也可以填入当前终端。真正执行以前，你仍然可以逐字检查。需要终端上下文时，可以附上最近的输出，常见凭据和个人信息会先做脱敏。

AI 命令助手支持 OpenAI 兼容服务，是否配置完全由你决定，不影响 SSH 和 SFTP 的正常使用。

![Luna Remote AI 命令助手](docs/images/ai-command.png)

## 还有一些每天都会碰到的细节

- 密码和密钥口令存入 macOS Keychain 或 Windows Credential Manager
- 支持本地转发、远程转发和 SOCKS5 动态转发
- 可以导入 SSH Config
- 连接配置可以备份和恢复
- 同一台服务器可以打开多个独立会话
- 界面主题、终端背景和应用图标都可以更换

## 下载

当前版本是 `v1.0.0`，发布页提供四种安装包。

- macOS Apple Silicon ARM64
- macOS Intel x64
- Windows x64 联网安装包
- Windows x64 WebView2 离线安装包

安装包目前没有开发者签名。macOS 首次运行时需要在“隐私与安全性”中确认，Windows 可能显示未知发布者或 SmartScreen 提示。

[前往 Releases 下载](https://github.com/rainj2013/luna-remote/releases)

## 想自己跑起来

环境搭建、项目结构、检查命令和打包发布都放在 [开发文档](docs/DEVELOPMENT.md) 里，README 只留给软件本身。
