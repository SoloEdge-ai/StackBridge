# 项目状态

更新日期：2026-09-18

| 范围 | 代码状态 | 验证状态 | 说明 |
|---|---|---|---|
| 仓库与设计资料 | implemented | verified | 本地 Git 与 `SoloEdge-ai/StackBridge` 私有远端已建立，原始资料保留在 `docs/design/` |
| Windows 真实终端 | implemented | verified | PowerShell/ConPTY、xterm.js、输入、Unicode、resize、Ctrl+C、单写者租约和刷新回放通过自动化与浏览器验收 |
| SSH/Docker 目标身份 | implemented | verified | 严格 OpenSSH、host key、runtime/boot、Docker daemon/full ID/start ticks/UID/cwd/shell binding 已在真实 Ubuntu 22.04 验证 |
| runtime 自动同步 | implemented | verified | linux/amd64、arm64 `0.2.0-dev` 产物可确认后同步到登录用户 `~/.sbridge`；摘要、原子切换和回滚保留 |
| SSH/Docker 交互 PTY | implemented | verified | UI 可创建真实 SSH Zsh 和 Ubuntu 22.04 Docker Bash PTY；实时输入、输出、cwd、状态、Ctrl+C 和刷新重附着通过实机验收 |
| 终端工作台 UI | implemented | verified | 终端主画布、唯一活动栏入口、紧凑标签、环境路径、停靠 AI 面板和标签关闭已通过 Chromium Playwright；关闭标签会释放 PTY/远端会话容量 |
| Shell 集成与命令块 | implemented | verified | PowerShell/Bash/Zsh 会话级集成；命令、输出、目录、退出码、环境归属和运行中快照有自动化覆盖 |
| 连续 AI 对话 | implemented | partially-verified | Codex App Server、模型列表、连续 thread、跨环境时间线、64 KiB 上下文、停止生成和历史恢复已实现；Fake Codex 通过，真实 OAuth 被当前网络地区限制阻塞 |
| 确认后同 Shell 执行 | implemented | verified-with-fake-ai | 不可变建议、五分钟过期、冻结作用域、核验环境、存活/空闲/空输入校验、写入租约、批准前持久化 operation、去重、实时可见执行和结果关联通过测试 |
| 本地持久化 | implemented | verified | SQLite 保存对话/建议/命令元数据，输出分块；7 天/1 GiB 清理和 migration 前备份有测试 |
| Windows 便携版 | implemented | verified-on-current-host | Electron 44 x64 单文件已生成；从产物本体启动后，生产同源页面、会话认证、随包 Codex App Server、真实 PowerShell/SSH/Docker PTY、WebSocket 输入和输出通过冒烟验证 |
| 文件修改/无人值守 Agent | not-started | not-started | 明确不属于本次交付 |

## 已知边界

- 当前受管远端 PTY由 Core 的系统 OpenSSH 进程持有。页面刷新可重附着；Core 重启、SSH 短断线后的远端 supervisor 恢复仍待 runtime 协议 3。
- 手输普通交互式 `ssh host` 会自动同步会话专用 Bash/Zsh 集成；远端 `docker exec -it` 的进入/退出已通过真实 Playwright 链路验证并记录为未核验环境。需要确认执行时仍使用“新建连接”建立完整 binding。
- 未适配 Shell、tmux/screen、提权 Shell、密码/MFA askpass 和没有交互 Shell 的容器降级为解释/复制建议，不开放自动提交。
- Shell 随机标记能隔离普通输出，但不是防御同 UID 恶意进程的强认证通道；受限命名管道/Unix socket 仍是后续安全加固项，runtime binding 不受该标记授权。
- 当前网络访问 OpenAI OAuth 返回 `unsupported_country_region_territory`；真实账号最终验收需要在受支持网络完成。
- 全屏 TUI、中文输入法组合输入、长时间高吞吐和干净 Windows 环境尚未形成完整验证矩阵；当前便携版未签名，首次启动可能触发 SmartScreen。

详细证据见 [AI 终端验证记录](AI-TERMINAL-VERIFICATION.md)和 [Windows 便携版验证记录](WINDOWS-PORTABLE-VERIFICATION.md)。
