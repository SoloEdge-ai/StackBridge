# 项目状态

更新日期：2026-09-18

| 范围 | 代码状态 | 验证状态 | 说明 |
|---|---|---|---|
| 仓库与设计资料 | implemented | verified | 本地 Git 与 `SoloEdge-ai/StackBridge` 私有远端已建立，原始资料保留在 `docs/design/` |
| Windows 真实终端 | implemented | verified | PowerShell/ConPTY、xterm.js、输入、Unicode、resize、Ctrl+C、单写者租约和刷新回放通过自动化与浏览器验收 |
| SSH/Docker 目标身份 | implemented | verified | 严格 OpenSSH、host key、runtime/boot、Docker daemon/full ID/start ticks/UID/cwd/shell binding 已在真实 Ubuntu 22.04 验证 |
| runtime 自动同步 | implemented | verified | linux/amd64、arm64 `0.2.0-dev` 产物可确认后同步到登录用户 `~/.sbridge`；摘要、原子切换和回滚保留 |
| SSH/Docker 交互 PTY | implemented | verified | UI 可创建真实 SSH Zsh 和 Ubuntu 22.04 Docker Bash PTY；实时输入、输出、cwd、状态、Ctrl+C 和刷新重附着通过实机验收 |
| 终端工作台 UI | implemented | verified | 默认英文，可在 Settings 中即时切换简体中文并持久化；`Ctrl+Shift+Space` 在聚焦窗格的 xterm 光标旁打开约 38px 高的单行 Quick Ask，仅保留上下文状态点、输入框和发送键，不改变终端高度，空间不足时自动翻转；Esc 返回终端且保留输入缓冲；右键提供解释输出、修复命令和横向/纵向分栏；每窗格持续环境链、提示符内联链路和 AI 目标已通过 Chromium Playwright |
| Shell 集成与命令块 | implemented | verified | PowerShell/Bash/Zsh 会话级集成；本地 PTY 与远端 Shell 在当前会话声明 `xterm-256color`，并为 ASCII 登录环境选择已有 UTF-8 locale；手输 SSH → Docker 后容器提示符持续回显完整链路且保留用户 rc 配置；命令、输出、目录、退出码、环境归属和运行中快照有自动化覆盖 |
| 连续 AI 对话 | implemented | verified | Codex App Server、连续 thread、跨环境时间线、64 KiB 上下文、停止生成和历史恢复已实现；随包 runtime 返回 Astra/Sol/Terra/Luna/GPT-5.5，默认 Luna；独立 `CODEX_HOME/auth.json` 已解决 Windows keyring 长 token 问题；稳定 App Server 请求、真实 OAuth、真实 Luna 回答在开发版与新便携版均已通过 |
| 确认后同 Shell 执行 | implemented | verified-with-fake-ai | 不可变建议、五分钟过期、冻结作用域、核验环境、存活/空闲/空输入校验、写入租约、批准前持久化 operation、去重、实时可见执行和结果关联通过测试 |
| 本地持久化 | implemented | verified | SQLite 保存对话/建议/命令元数据，输出分块；7 天/1 GiB 清理和 migration 前备份有测试 |
| Windows 便携版 | implemented | verified-on-current-host | Electron 44 x64 单文件已生成；从产物本体启动后，生产同源页面、会话认证、随包 Codex App Server、真实 PowerShell/SSH/Docker PTY、WebSocket 输入和输出通过冒烟验证 |
| 文件修改/无人值守 Agent | not-started | not-started | 明确不属于本次交付 |

## 已知边界

- 当前受管远端 PTY由 Core 的系统 OpenSSH 进程持有。页面刷新可重附着；Core 重启、SSH 短断线后的远端 supervisor 恢复仍待 runtime 协议 3。
- 手输普通交互式 `ssh host` 会自动同步会话专用 Bash/Zsh 集成；远端普通 `docker exec -it ... bash/zsh` 会在容器内当前用户的随机临时目录加载命令作用域脚本，保留并加载原有 rc 配置，加载后立即清理。派生标记只允许 prompt/命令/cwd/退出码，不能改变环境栈或 binding。真实 Ubuntu Bash 与 Zsh 容器的环境进入、内部命令归属、连续提示符链路回显、rc 哈希未变和退出均通过 Playwright 验证，并记录为未核验环境。需要确认执行时仍使用“新建连接”建立完整 binding。
- 未适配 Shell、tmux/screen、提权 Shell、密码/MFA askpass 和没有交互 Shell 的容器降级为解释/复制建议，不开放自动提交。
- Shell 随机标记能隔离普通输出，但不是防御同 UID 恶意进程的强认证通道；受限命名管道/Unix socket 仍是后续安全加固项，runtime binding 不受该标记授权。
- ChatGPT 登录、凭据持久化和真实回答已通过随包 App Server；命令建议仍按设计逐条冻结目标并要求用户确认。
- 全屏 TUI、中文输入法组合输入、长时间高吞吐和干净 Windows 环境尚未形成完整验证矩阵；当前便携版未签名，首次启动可能触发 SmartScreen。

详细证据见 [AI 终端验证记录](AI-TERMINAL-VERIFICATION.md)和 [Windows 便携版验证记录](WINDOWS-PORTABLE-VERIFICATION.md)。
