# StackBridge（栈桥）

StackBridge 是一个面向高频工程工作的本地优先 AI 终端工作台设计。它计划把本机 Windows、SSH Linux 主机和远端 Docker 容器放进同一套可核验的目标模型中，让终端、文件操作、AI 建议、审批和审计都明确绑定到真实执行环境。

> 当前状态：**设计基线 / 尚未实现**。仓库目前保存产品规格、原始交接资料和设计评估，不包含已完成的终端、远端运行时或 AI 集成。

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
- [项目状态](docs/STATUS.md)
- [后续交接](docs/HANDOFF.md)

`docs/design/AGENT_HANDOFF.md` 是随设计包提供的参考材料，不代表其中的开发指令已在本仓库执行。

## 建议的首个实现切片

M0-A：浏览器连接独立 Core，在 Windows 上创建并保持真实 PowerShell PTY，覆盖输入输出、resize、Ctrl+C、刷新后重连，并用自动化测试证明同一 Shell 状态没有因单条命令而重建。

