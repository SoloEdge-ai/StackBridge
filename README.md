# StackBridge（栈桥）

StackBridge 是一个面向高频工程工作的本地优先 AI 终端工作台。它计划把本机 Windows、SSH Linux 主机和远端 Docker 容器放进同一套可核验的目标模型中，让终端、文件操作、AI 建议、审批和审计都明确绑定到真实执行环境。

> 当前状态：**M0-A Windows Web 终端原型和 M0-B0 目标协议已实现并验证**。现有代码可以从浏览器连接独立 Core，使用真实 PowerShell/ConPTY，并在刷新后附着同一会话；ConnectionProfile、ExecutionTarget、RuntimeBinding 与 ExecutionRequest 已有版本化运行时 schema。SSH/Docker 执行器、AI 和 Electron 尚未实现。

## 运行 M0-A

要求 Windows、Node.js 22.14+ 和 pnpm 10.33+。

```powershell
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173`，把 Core 输出的启动令牌粘贴到登录页。认证后浏览器获得 HttpOnly 本地会话 cookie；启动令牌不会保存到 Web Storage。

常用验证命令：

```powershell
pnpm typecheck
pnpm test
pnpm build
```

当前工作区：

- `apps/core`：独立 Node.js Core、HTTP/WS 鉴权边界、PowerShell PTY、有界重连缓冲与单写者租约。
- `apps/web`：React/Vite 单终端页面与 xterm.js。
- `packages/protocol`：Web/Core 共用的运行时消息 schema。

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
- [领域词汇](CONTEXT.md)
- [项目状态](docs/STATUS.md)
- [后续交接](docs/HANDOFF.md)

`docs/design/AGENT_HANDOFF.md` 是随设计包提供的参考材料，不代表其中的开发指令已在本仓库执行。

文档职责：`STACKBRIDGE_SPEC.md` 是产品与架构基线；`ANALYSIS.md` 记录评估与待澄清项；`STATUS.md` 和 `HANDOFF.md` 只保存当前实施快照。调整需求或里程碑时先更新规格，再同步快照，避免多个路线版本并存。

## 当前限制

- 会话和最多 1 MiB 的回放缓冲只存在于 Core 内存中；Core 重启后不可恢复。
- 多页面可同时查看同一终端，但只有一个页面持有写入租约；后打开的页面默认只读，可显式接管输入。
- 尚未验证中文输入法、全屏 TUI、长时间高吞吐或打包后的干净 Windows 安装环境。
- 当前 UI 通过 Vite 开发代理访问 Core；生产同源静态文件服务和 Electron 外壳尚未实现。
