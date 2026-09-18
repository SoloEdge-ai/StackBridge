# Windows 便携版验证记录

验证日期：2026-09-18

## 产物

- 文件：`release/StackBridge-Portable-x64.exe`
- 架构：Windows x64
- 大小：179,539,208 bytes（171.2 MiB）
- SHA-256：`2EE00DCB3C0F136EC7F19086D0E661B304A11D3DA1B12ED2EC09F1CAAEEFBCA0`
- 签名状态：未签名

`release/` 是本地构建输出并被 Git 忽略，不提交二进制。使用 `pnpm desktop:portable` 可从已锁定依赖重新生成。

## 验证结果

从便携 EXE 本体启动，而不是从源码或 Vite 开发服务器启动。验证到以下事实：

1. 单文件成功解压并启动打包后的 `StackBridge.exe`。
2. Core 在随机回环端口启动，生产 Web 由同一个本地服务提供。
3. 初始页面无需启动令牌即可加载，并自动使用本机 Origin 校验和 HttpOnly 会话 Cookie。
4. 通过打包后的 Core 创建真实 PowerShell/ConPTY 会话。
5. 通过打包后的终端 WebSocket 提交 `Write-Output 'PORTABLE_SMOKE_OK'`，收到包含 `PORTABLE_SMOKE_OK` 的终端输出。
6. Linux amd64/arm64 远程 runtime 均随便携包提供，并由 Core 在启动时成功读取 manifest。
7. `codex-cli 0.155.0-alpha.2.6` Windows x64 与 `rg.exe` 随包提供；Core 在打包模式下固定使用该二进制，不依赖 PATH 中已有的 Codex 或 Node.js。
8. 打包后的 Codex App Server 成功启动并返回可用的未登录账号状态；真实 ChatGPT 登录仍取决于用户网络和账号。
9. 从 EXE 的 Core 建立 `friden@friden-dev-cube` 核验 SSH PTY，执行命令并收到 `PORTABLE_SSH_OK`。
10. 从 EXE 的 Core 建立 `stackbridge-m0b1-ubuntu22` 完整容器 binding，执行命令并收到 `PORTABLE_DOCKER_OK`。
11. 打包后的 Web 产物确认只有一组“新建连接 / AI 助手”入口，且已移除 `Workspace / StackBridge` 品牌块；Electron 使用隐藏标题栏和原生窗口控制 overlay。
12. 从本次 EXE 本体启动随机回环 Core，确认生产 Web bundle 包含右键横向/纵向分栏与窗格内紧凑环境链；无需启动令牌即可创建并关闭真实本地 PowerShell/ConPTY 会话。
13. 生产 UI 默认英文，Settings 可即时切换简体中文并由 Core 持久化；刷新和重启后保留选择。
14. Codex App Server 使用独立 `CODEX_HOME` 和文件型凭据存储，避免 Windows keyring 对长 OAuth token 的长度限制。
15. 手输 SSH 后进入 Bash/Zsh Docker 时，产物内包含命令作用域子标记、随机临时 rc 注入和完整链路回显；真实 Playwright 已验证内部命令归属及原始 `.bashrc`/`.zshrc` 哈希不变。
16. 手输 `ssh L001` 时，打包后的 PTY 与远端 Shell 均使用 `TERM=xterm-256color`，并选择远端已有的 UTF-8 locale；真实 Playwright 确认 Oh My Zsh 提示符显示为 `➜`，不会再出现 `?➜`。
17. 新 EXE 本体在随机回环端口启动后，Playwright 验证 `Ctrl+Shift+Space` 在真实 xterm 光标旁打开 Quick Ask，不改变终端尺寸；环境链、cwd、Shell 和输出数量持续可见，编辑器可增长至三行，后台输出会带动浮层跟随光标，底部空间不足时向上翻转。Esc 保留未提交输入，并通过随包 Codex App Server 收到一次真实模型回答。

## 当前边界

- 当前只有 x64 便携版，没有 ARM64、标准安装包、自动更新或代码签名。
- 尚未在全新 Windows 虚拟机上运行完整 SSH/Docker/Codex 验收矩阵。
- 未签名产物可能触发 SmartScreen；发布给外部用户前应配置可信代码签名证书。
