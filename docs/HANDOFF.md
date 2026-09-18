# 当前交接

更新日期：2026-09-18

## 当前可用链路

StackBridge 已从结构化远端执行原型升级为终端优先工作台：

- 本地 Windows 使用 PowerShell/ConPTY；SSH 和 Docker 标签使用真实交互 PTY。
- 临时 PowerShell/Bash/Zsh 集成提供命令边界、cwd、退出状态和环境层级，不修改用户永久 Shell 配置。
- 页面刷新重新附着 Core 中的 PTY 并回放有界输出；多页面使用单写者租约。
- 终端区域右键可创建横向（左右）或纵向（上下）分栏；每个窗格拥有独立 TerminalSession/PTY。受管 SSH/Docker 分栏复制连接配置并重新核验；每个窗格自己的紧凑状态线持续显示环境链、cwd 和 Shell，PowerShell/Bash/Zsh 每次提示符前也回显链路，状态栏和 AI 上下文跟随聚焦窗格。
- 关闭终端标签会显式终止 PTY，并释放关联的本地/远端会话容量；普通刷新不会触发关闭。
- Codex App Server 使用独立 `CODEX_HOME` 与系统 keyring；一个连续对话对应一个 Codex thread。
- 每次提问冻结终端、环境、binding、cwd、Shell、context/input 版本；跨环境历史写入同一对话时间线。
- 默认上下文包含最近 20 条命令、最近 3 条输出或运行中快照，输出上限 64 KiB，并做控制字符清理和基础敏感信息遮蔽。
- AI 只能返回回答与命令建议。Core 拥有不可变建议和持久化 operation；执行需要逐条确认、五分钟内有效、原目标未变、环境已核验、Shell 仍存活且空闲、输入为空，并且批准页面持有写入租约。
- 经确认命令在原 Shell 执行，所以 `cd`、`export` 和虚拟环境状态继续有效；重复确认、刷新和重试不会二次提交。
- SQLite 保存对话、冻结建议和命令元数据，终端输出分块保存；默认七天/1 GiB 清理。
- Windows x64 便携版将生产 Web、Core、ConPTY 依赖、`codex-cli 0.128.0` 和 Linux 远程 runtime 封装为单文件；Electron 仅管理窗口、随机回环端口和进程生命周期。

## 实机状态

- Windows 本地 PowerShell：真实输入、Unicode、emoji、resize、Ctrl+C、同 Shell 状态、刷新重附着已验证。
- `friden@friden-dev-cube`：真实 Zsh PTY、cwd、中文输出和 Ctrl+C 已验证。
- `stackbridge-m0b1-ubuntu22`：真实 Bash PTY、三层环境路径、环境变量/cwd 保留和刷新重附着已验证。
- runtime `0.2.0-dev` 通过 `golang:1.24-bookworm` 构建和 Go 测试，amd64 产物已通过一次性确认升级到 `/home/friden/.sbridge`；arm64 产物已构建。
- 当前 OpenAI OAuth 页面返回 `unsupported_country_region_territory`。登录入口、状态查询和取消已接通，但真实 ChatGPT 回合必须在受支持网络下最终验收。

## 启动与验证

直接使用本地便携产物：

```text
release/StackBridge-Portable-x64.exe
```

重新生成产物：

```powershell
pnpm desktop:portable
```

```powershell
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173` 会自动建立本机浏览器会话并进入工作台，无需启动令牌。默认 AI 快捷键是 `Ctrl+Shift+Space`，`Esc` 返回终端焦点。

```powershell
pnpm typecheck
pnpm test
pnpm build
```

远端复测使用 UI“新建连接”，默认 fixture 为：

```text
SSH:    friden@friden-dev-cube:22
Docker: context=default, container=stackbridge-m0b1-ubuntu22,
        user=root, cwd=/workspace
```

## 明确剩余边界

- 从旧 `stackbridge.terminalTabs.v2` 会话存储迁移的已打开远端标签没有保存原连接参数，因此该标签第一次分栏会明确创建本地 PowerShell；用“新建连接”重新打开一次后进入 v3 存储，后续刷新与分栏即可复制并重新核验同一 SSH/Docker 目标。
- Go runtime 仍是协议 2 的安装、身份和结构化执行通道。当前远端 PTY由 Core 的 OpenSSH 进程持有；协议 3 supervisor、PTY 分帧和 SSH 短断线/Core 重启重附着未实现。
- 手输普通交互式 `ssh host` 会把当前 PTY 的会话专用集成同步到远端 `~/.sbridge/shell`；远端 `docker exec -it` 的进入/退出会产生未核验环境事件。带远端命令的 SSH、嵌套 SSH 和绕过包装器的连接仍降级；完整自动执行能力只对“新建连接”创建的受管标签开放。
- Shell 随机标记不是针对同 UID 恶意进程的强认证通道；受限命名管道/Unix socket 仍待后续安全加固，runtime binding 不依赖该标记授权。
- 没有完成密码/MFA askpass、tmux/screen、提权 Shell、全屏 TUI、中文输入法组合输入和长时间高吞吐矩阵。
- Codex 动态客户端工具与统一 `/v1/events` 流尚未实现；当前由 Core 预组装上下文、HTTP 返回 AI 回合并轮询 operation。
- Windows 便携版仅完成 x64 当前宿主验证，尚无代码签名、自动更新、标准安装包和干净 Windows 矩阵；文件自动修改、外部插件、子代理或无人值守循环仍未提供。

## 建议下一步

1. 在受支持网络完成真实 ChatGPT 登录、真实回答、建议卡、确认执行和后续解释的最终验收。
2. 将远端 PTY 下沉到 runtime 协议 3 supervisor，补齐短断线与 Core 重启恢复。
3. 扩展 Playwright 到真实 ChatGPT 回合，并补中文输入法/全屏 TUI/吞吐矩阵。
4. 在便携版稳定后补应用图标、代码签名、自动更新与标准安装包，不扩大本次终端助手的工具权限。

完整证据见 [AI 终端验证记录](AI-TERMINAL-VERIFICATION.md)和 [Windows 便携版验证记录](WINDOWS-PORTABLE-VERIFICATION.md)。
