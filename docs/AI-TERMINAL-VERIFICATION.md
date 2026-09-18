# AI 终端垂直链路验证记录

更新日期：2026-09-18

## 已实现范围

- xterm.js 多标签、多分栏终端工作台；右键可创建横向（左右）或纵向（上下）分栏，每个窗格对应独立 TerminalSession/PTY。受管 SSH/Docker 分栏复制连接配置并重新核验同一目标。Core 持有真实 ConPTY/SSH/Docker PTY，页面刷新只重新附着和回放，不重跑命令。
- Windows PowerShell 5.1 会话级集成；手输普通交互式 `ssh host` 时，将同一个 PTY 的会话专用 Bash/Zsh 集成同步到登录用户私有的 `~/.sbridge/shell`，远端 `docker exec -it` 包装器在进入/退出时推送和弹出 Docker 环境。整个过程不修改 PowerShell Profile、`.bashrc` 或 `.zshrc`。每个 PTY 使用独立随机标记，普通、无标记的终端输出不能改变 Shell 状态；runtime binding 始终由 Core 独立核验，不从 OSC 建立。
- 原 53px 全局环境栏已移除；每个终端窗格内用 27px 紧凑状态线持续显示本地 → SSH → Docker 层级、cwd、Shell 和核验状态。受管 PowerShell/Bash/Zsh 在每次提示符前回显同一链路；完整 Docker binding 使用 runtime 核验的 daemon、容器 ID、启动时间和 init start ticks。
- `CommandBlock` 记录人工/AI 来源、环境层、binding、cwd、用户、Shell、时间、退出码、输出范围与捕获质量；运行中的命令可生成截至提问时的屏幕输出快照。
- 一个 `ConversationSession` 对应一个 Codex thread；每次 turn 冻结独立 `AgentSession`。跨终端提问保留同一对话，并插入环境时间线。
- Codex App Server 使用独立 `CODEX_HOME`、系统 keyring 和只读 sandbox；关闭原生 shell/web search，不向模型提供文件、浏览器、插件或子代理工具。
- 默认上下文为最近 20 条命令摘要、最近 3 条输出和显式引用记录，总输出上限 64 KiB；清理 ANSI/OSC，并对私钥块和常见 token 前缀做基础脱敏。
- 模型输出被 Core 转换为不可变 `CommandProposal`。建议绑定终端、环境层、binding、cwd、Shell、上下文版本和输入版本，五分钟过期。
- “执行”要求原作用域仍有效、环境与 binding 已核验、Shell 仍存活且空闲、输入行为空，并且当前浏览器会话持有写入租约。Core 在 SQLite 事务中先持久化 `operationId` 与批准状态，再向同一个 Shell 提交；重复批准只查询同一操作。
- SQLite 保存连续对话、冻结建议和执行 operation；命令输出按文件分块保存。默认输出保留七天、总量 1 GiB，清理后保留命令元数据和截断标记。

## 实机验证

验证工作台：Windows NT `10.0.26200.0`、Node.js `22.14.0`、pnpm `10.33.0`、xterm.js/ConPTY。

验证远端：`friden@friden-dev-cube`、Docker Engine `29.4.0`、容器 `stackbridge-m0b1-ubuntu22`（Ubuntu 22.04.5 LTS）。runtime `0.2.0-dev` 的 linux/amd64 与 linux/arm64 二进制在隔离的 `golang:1.24-bookworm` 容器构建；Go 测试在相同容器通过，amd64 产物部署到 `/home/friden/.sbridge`。

完成的浏览器验收：

1. 本地 PowerShell 启动只显示正常提示符，临时集成命令不暴露；中文、emoji、`cd` 和环境变量状态正常。
2. SSH 标签进入真实 Zsh，窗格内状态线与提示符回显均显示 `本地 Windows → friden@friden-dev-cube`；cwd 从 `/home/friden` 更新为 `/tmp`，中文输出和 `Ctrl+C` 正常。
3. Docker 标签进入真实 Bash，窗格内状态线与提示符回显均显示完整三层路径；runtime 优先选择可用 Bash，修复了 `/bin/sh --rcfile` 不兼容。
4. 在容器设置 `APP_ENV=stackbridge` 并切换到 `/tmp`；页面刷新后重新附着同一 PTY，变量与 cwd 保留，命令没有重跑。
5. 回放期间暂停 xterm 自动回复的输入转发，避免刷新时把 terminal capability response 写入当前提示符。
6. runtime 版本变化触发一次性部署提案；批准后安装到 `~/.sbridge`，随后连接静默复用匹配摘要的产物。
7. Playwright 从无 Cookie 的新浏览器直接打开工作台，无需任何启动令牌；真实输入 PowerShell 命令并看到输出，快捷键可收放 AI 面板。
8. Playwright 经 UI 连接真实 `friden-dev-cube` SSH/Zsh 和 Ubuntu 22.04 Docker/Bash，环境均为已核验，实际命令输出分别为 `PLAYWRIGHT_SSH_OK` 与 `PLAYWRIGHT_DOCKER_OK`。
9. 关闭终端标签会终止对应 PTY、释放本地和远端会话容量；Playwright 每条用例清理自己创建的终端，长期运行 Core 不再因测试积累达到 16 会话上限。
10. Playwright 在本地 PowerShell 手输 `ssh friden-dev-cube`，确认 cwd/Shell 更新为 `/home/friden` 与 Zsh；随后手输 `docker exec -it stackbridge-m0b1-ubuntu22 bash`，窗格环境链出现 Docker 层，`exit` 后恢复 SSH 层。
11. Playwright 从终端右键菜单分别创建左右和上下分栏；新窗格建立独立 PowerShell/ConPTY，能够独立输入与输出，刷新后恢复布局，单独关闭时折叠布局。
12. Playwright 对真实 `friden-dev-cube` SSH/Zsh 与 `stackbridge-m0b1-ubuntu22` Docker/Bash 分别创建新分栏，确认每个窗格独立显示完整环境链、执行命令，并在下一次提示符前再次回显该链路；活动状态和 AI 目标随聚焦窗格切换。

## 自动化验证

- 协议 schema：本地/SSH/Docker 终端创建、Conversation、Turn、Proposal、Approval 与 Operation。
- Shell marker 状态机：认证标记、伪造 marker 拒绝、命令边界、输出归属、环境 push/pop、运行快照、上下文版本和 UTF-8 有界回放。
- 真实 Windows PTY：同 Shell 状态、Unicode、resize、Ctrl+C 和命令块。
- Conversation/Fake Codex：64 KiB 上下文、连续对话、跨环境时间线、冻结作用域、建议生成和 stale 拒绝。
- 审批 HTTP/WS：浏览器不能注入命令字段；无写入租约拒绝；批准只写入一次；重复请求返回同一 operation。
- SQLite：重启后恢复对话/建议/operation，批准记录在 PTY 写入前落盘；命令元数据和分块输出可读，超出预算后只清理输出。
- Go runtime：身份、结构化 argv、Docker binding、超时、安装路径和 Bash 优先探测。
- Playwright：7 条 Chromium 端到端用例覆盖零令牌启动、本地真实终端、AI 快捷键、左右/上下分栏、布局恢复、真实受管 SSH/Docker 分栏与链路回显、连接表单，以及手输 SSH → Docker 的环境进入/退出。

运行：

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @stackbridge/web test:e2e
$env:STACKBRIDGE_E2E_REMOTE='1'; pnpm --filter @stackbridge/web test:e2e
```

## 外部阻塞与兼容边界

StackBridge 能启动官方 ChatGPT OAuth，并支持查询、取消和退出登录。当前测试网络访问 `auth.openai.com` 返回 `unsupported_country_region_territory`，所以无法在该网络完成真实账号回合。真实登录、模型回答和真实建议卡的最终验收需要在 OpenAI 支持的网络位置由用户完成；这不通过复制现有 Codex token 绕过。

当前 Shell 标记用于阻止普通输出和意外 OSC 注入，不是针对同一操作系统用户下恶意进程的强认证边界：同 UID 进程可能读取 Shell 启动参数或私有 rc 文件中的标记并伪造命令状态，但不能伪造 Core 核验的 runtime binding。在改为当前用户专用命名管道/Unix socket 前，不把该标记等同于受限 IPC 的安全强度。

当前远端交互 PTY由 Core 持有的系统 OpenSSH 会话承载；页面刷新可以恢复，但 Core 重启或 SSH 传输断开后尚不能重新附着远端 supervisor。Go runtime 仍是协议 2 的身份/安装/结构化执行通道，协议 3 的 supervisor、PTY 分帧和短断线恢复是后续稳定性工作，不能计入本次已验证声明。

手动输入普通交互式 `ssh host` 时会自动同步会话专用 Shell 集成，随后在远端输入 `docker exec -it` 会记录环境进入/退出；这些无法独立核验的子 Shell 显示“环境未核验”，禁止确认后自动执行。带远端命令的 SSH、嵌套 SSH、绕过包装器及复杂自定义连接仍属于降级边界。完整核验和建议执行使用“新建连接”创建的受管 SSH/Docker 标签。

从旧 `stackbridge.terminalTabs.v2` 迁移的浏览器标签只保存了会话 ID、标题和类型，没有可安全重放的主机、端口、用户、Docker context 与容器参数。这类旧标签的分栏菜单明确显示“新 PowerShell”；重新通过“新建连接”打开一次后，v3 存储会保留不含部署批准凭据的可复用连接定义，随后分栏才复制并重新核验同一远端目标。

当前 Codex 回合使用 Core 预组装的冻结上下文与结构化建议输出；计划中的三个 App Server 动态客户端工具尚未开放。AI 文本当前以一次 HTTP 回合返回，operation 使用有界轮询；统一 `WS /v1/events` 和增量 AI 文本流仍属于后续协议工作。这不影响已验证的终端、上下文解释、逐条确认和同 Shell 提交主链路，但不计入完整计划已完成项。
