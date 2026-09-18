# StackBridge（栈桥）

StackBridge 是一个面向高频工程工作的本地优先 AI 终端工作台。它计划把本机 Windows、SSH Linux 主机和远端 Docker 容器放进同一套可核验的目标模型中，让终端、文件操作、AI 建议、审批和审计都明确绑定到真实执行环境。

> 当前状态：**可用的 AI 终端垂直链路已实现**。浏览器可使用真实 PowerShell、SSH Linux 和远端 Docker PTY；临时 Shell 集成记录命令、目录、输出和环境；连续 Codex 对话自动附带有界上下文；AI 建议只有在用户逐条确认、目标仍匹配且页面持有写入租约时，才会在原 Shell 执行一次。Electron 和无人值守 Agent 不在本次范围内。

## 运行当前原型

要求 Windows、Node.js 22.14+ 和 pnpm 10.33+。

```powershell
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173` 即可直接进入工作台。页面会自动建立仅限本机且受 Origin 校验保护的浏览器会话，不需要复制或输入启动令牌。可以新建本地、SSH 或远端 Docker 终端；`Ctrl+Shift+Space` 打开/收起 AI 对话。远端连接复用系统 OpenSSH 配置与 `known_hosts`；首次安装或版本变化时，UI 会展示路径、版本、用户、主机指纹与权限，确认后才写入登录用户的 `~/.sbridge`。在终端手输普通 `ssh host` 时，当前会话专用的 Bash/Zsh 集成会自动同步到远端用户私有的 `~/.sbridge/shell`，因此后续手输 `docker exec -it ...` 也能显示进入和退出的环境层级。

AI 面板使用独立的 StackBridge Codex 数据目录。点击“使用 ChatGPT 登录”完成官方授权；StackBridge 不复制当前 Codex 应用的 token 文件。提问时默认发送当前环境、最近 20 条命令摘要和最近 3 条输出，总量最多 64 KiB。所有建议执行前都需要再次确认。

常用验证命令：

```powershell
pnpm typecheck
pnpm test
pnpm build
```

当前工作区：

- `apps/core`：独立 Node.js Core、HTTP/WS 鉴权边界、PowerShell/SSH/Docker PTY、Shell 集成、Codex App Server、审批状态机和 SQLite/分块输出持久化。
- `apps/web`：React/Vite+xterm.js 终端工作台、可关闭多标签、环境栏、连续 AI 对话、上下文预览和命令建议卡。
- `packages/protocol`：Web/Core 共用的运行时消息 schema。
- `runtime`：Linux Go runtime，提供自安装/回滚、身份握手、结构化 argv 与经宿主核验的 Docker 执行；仓库内置 amd64/arm64 静态产物。

## 核心方向

- Windows 客户端优先，同时允许浏览器直接连接独立 Core。
- React + TypeScript + Vite Web UI；Electron 只承担桌面外壳职责。
- 独立 Node.js Core 管理会话、策略、审批和持久化。
- 本地 Windows 使用 ConPTY；远端 Linux 使用轻量 Go runtime。
- SSH 复用系统 OpenSSH；Docker 通过宿主进入容器，不要求容器运行 sshd。
- ChatGPT/Codex 与 API 模型采用不同适配路径，模型凭证默认留在本机。
- 所有 AI 文件与执行工具都绑定经核验的 target/runtime binding，并通过统一 Tool Gateway。

## 设计判断

规格的最大价值不在 UI 形态，而在三个安全与一致性不变量：逻辑目标和真实实例必须分离；Agent 会话必须冻结目标绑定；审批必须绑定完整动作与目标身份。它们应先于复杂界面、模型扩展和工作流实现。

项目的首要技术风险是 Windows PTY 生命周期、SSH/Docker 跨目标防串线、Codex App Server 的可控工具边界，以及跨 TS/Go 的协议兼容。建议用四个小型真实垂直切片验证这些风险，再进入完整产品开发。

详见 [设计评估](docs/ANALYSIS.md)。

## 文档

- [产品与工程实施规格](docs/design/STACKBRIDGE_SPEC.md)
- [原始开发 Agent 交接材料](docs/design/AGENT_HANDOFF.md)
- [设计评估](docs/ANALYSIS.md)
- [M0-A 协议](docs/PROTOCOL.md)
- [M0-B0 目标身份协议](docs/TARGET_PROTOCOL.md)
- [M0-B1 SSH/Docker 验证记录](docs/M0-B1-VERIFICATION.md)
- [M0-B2 runtime 自动同步与 UI 验证记录](docs/M0-B2-VERIFICATION.md)
- [AI 终端验证记录](docs/AI-TERMINAL-VERIFICATION.md)
- [连续对话与冻结执行作用域 ADR](docs/adr/0002-continuous-conversation-frozen-execution.md)
- [领域词汇](CONTEXT.md)
- [项目状态](docs/STATUS.md)
- [后续交接](docs/HANDOFF.md)

`docs/design/AGENT_HANDOFF.md` 是随设计包提供的参考材料，不代表其中的开发指令已在本仓库执行。

文档职责：`STACKBRIDGE_SPEC.md` 是产品与架构基线；`ANALYSIS.md` 记录评估与待澄清项；`STATUS.md` 和 `HANDOFF.md` 只保存当前实施快照。调整需求或里程碑时先更新规格，再同步快照，避免多个路线版本并存。

## 当前限制

- 页面刷新可重新附着 Core 持有的本地/远端 PTY；Core 重启后会恢复对话和命令历史，但本地 PowerShell 进程不保证存活，远端 supervisor/短断线重附着仍待协议 3 实现。
- 多页面可同时查看同一终端，但只有一个浏览器会话持有写入租约；确认执行也要求同一会话持有该租约。
- 普通 PowerShell、Bash 和 Zsh 已支持；手输常见 `ssh host` 与远端 `docker exec -it` 可跟踪未核验环境。tmux/screen、提权 Shell、未适配 Shell、密码/MFA askpass、带远端命令的 SSH 和绕过临时包装器的连接只提供降级能力。
- Shell 随机标记用于隔离普通输出，不等同于防御同 UID 恶意进程的受限 IPC 安全边界；runtime binding 始终由 Core 独立核验。
- 当前网络位置的 OpenAI 授权端点返回 `unsupported_country_region_territory`，因此真实 ChatGPT 回合需要在受支持网络下完成；Fake Codex 覆盖了协议、上下文、建议、批准、同 Shell 执行和去重测试。
- 尚未完成全屏 TUI、中文输入法组合输入和持续高吞吐压力的完整验收，也没有生产同源静态服务、Electron 外壳或安装包签名。
- 首版不提供文件自动修改、原生命令工具、外部插件、子代理或无人值守循环。
