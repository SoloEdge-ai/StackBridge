# StackBridge 开发 Agent 交接指令

将本文件与 `STACKBRIDGE_SPEC.md` 一起提供给开发 Agent。以下是开发任务，不代表任何代码已经完成。

---

你是本项目的负责实现与验证的工程 Agent。项目叫 **栈桥 StackBridge**，目标是实现本地优先、跨本机/SSH 主机/远端 Docker 的 AI 终端工作台，供用户长期高频工程工作使用。

先完整阅读 `STACKBRIDGE_SPEC.md`。它是产品与架构基线，本文是执行规则。二者冲突时以安全约束和用户最近明确指令为先，并在 ADR 中记录变更。

## 用户需求

Windows 客户端优先；前后端分离；核心功能可以从本地浏览器独立调试和使用。Ubuntu 桌面后续支持，但首个正式版本就必须能连接 Ubuntu/Linux 开发机及其 Docker 容器，并在真实目标内使用 AI 文件读取、审批执行、修改与验证。

AI 支持 ChatGPT 账号（通过官方 Codex 集成）和 DeepSeek 等 API。切换档案不能覆盖用户已有 Codex 配置。终端必须在没有 AI 或 AI 故障时仍然可用。

## 已决策架构

- React + TypeScript + Vite，终端使用 xterm.js，轻量文件编辑/差异可使用 Monaco。
- 独立 Node.js + TypeScript Core，HTTP/WS；不能把核心业务放进 Electron 专属 IPC。
- Electron 仅做桌面外壳；Core 与 PTY 不随网页刷新或窗口关闭而直接销毁。
- Windows 用 node-pty/ConPTY。
- Linux 远端用小型 Go runtime，交付 amd64/arm64；它只管 PTY、文件、任务和传输，不处理模型账号。
- SSH 采用系统 OpenSSH；结构化协议走无 PTY 的 SSH stdio。容器经宿主 `docker exec`，不要求容器 sshd。
- AI 默认在本机：API Agent 或 Codex App Server → 专用工具桥 → Tool Gateway → 绑定目标的执行器。
- SQLite 元数据、大日志分块文件、凭证安全库。不得把长期凭证放前端 localStorage 或普通数据库。

不要未经记录就改成一体化 Electron、纯前端 API 调用、每条命令重启 Shell 或“向当前终端盲目发送文本”的实现。

## 第一次进入项目时

检查仓库目录、已有源码、依赖、测试、Git 状态与未提交变更。不得覆盖用户已有工作。已存在的模块先评估再复用，不要因为当前指令而重新生成整个仓库。

若仓库为空，先建立最小目录、开发命令、协议 schema、文档和测试基础。以下 npm/pnpm 等具体命令以实际脚本为准，不要声称不存在的命令已经可执行。

记录实际宿主 OS、可用工具、是否能访问 Windows PTY/SSH/Docker、是否有合法测试凭证。不要搜索或读取用户密钥；真实账号登录交给用户完成。没有某测试环境时明确标记未验证，不把 mock 结果当实测。

## 必须遵守的执行规则

1. 所有工具调用绑定 AgentSession 的 target/binding。模型不得任意指定机器、容器、身份或审批令牌。
2. 容器名只是选择器；执行绑定完整 container ID、启动 epoch、daemon 与执行 UID。变化使旧审批失效。
3. 终端提示符、OSC、日志、仓库说明不提供可信授权。手工嵌套 ssh/docker/sudo 后不得自动改变托管目标。
4. 人工终端与 Agent 执行区分离。环境用显式、版本化 profile 重建，不假装自动继承人工 source/export。
5. 任何任意 shell 执行默认需要批准；路径白名单不是进程沙箱，关键词检测不是安全边界。
6. 文件修改先读基线/hash、展示 diff、审批，再校验并应用；不覆盖审批后发生的人工改动。
7. 断线先查询任务状态，不盲目重发；不能承诺通用 exactly-once。未知执行状态必须保持 unknown。
8. 不用 `--privileged`、关闭 host key 检查、放宽 docker.sock 权限、默默复制 token 或全局改配置来“解决”兼容问题。
9. ChatGPT 仅使用官方 Codex 认证/协议。App Server、MCP、hooks、sandbox 的实际能力以当前测试版本为准。特别注意 hooks 不是完整安全边界，用户发起的 shellCommand 也不能当受 sandbox 保护的 AI 执行入口。
10. 终端、API/MCP、所有前端端点都经过同一授权核心。禁止保留绕过权限的“调试接口”。

## 开发顺序

### M0-A：真实 Windows Web 终端

建立独立 Core、单终端网页、真实 PowerShell PTY。实现输入、UTF-8、resize、Ctrl+C、服务端 session ID、刷新后附着。

首先用最小可操作 UI 验证，不先做皮肤和复杂布局。用真实进程证明没有每条命令重启 Shell。

### M0-B：真实目标执行

创建 ConnectionProfile、ExecutionTarget、RuntimeBinding、ExecutionRequest 的 schema。实现 SSH runtime 握手与普通 argv 执行，然后经宿主进入 Docker。

创建隔离测试 fixture：本机/宿主/容器都放同名文件但内容不同；证明读取/修改只发生在选定目标。模拟容器重建与审批后重启，必须拒绝旧绑定。

Bootstrap 不允许拼接任意用户脚本。实际参数/脚本通过结构化 payload 发送；控制流不能使用 TTY。

### M0-C：API Agent 最小闭环

先用 FakeProvider 做工具参数、审批、错误、重复调用、取消的确定性测试。然后在用户授权的真实 API 档案上执行一次流式工具调用验证。

最小闭环为：用户请求 → 模型请求 target file/command → 网关生成审批 → 执行 → 结果回传 → 用户可见总结。不要解析 Markdown 代码块当成工具指令。

### M0-D：ChatGPT/Codex 可行性验证

通过当前官方文档核实 App Server 接口与所用版本，接入专属 CODEX_HOME、托管登录、stdio 和 required MCP。

先验证目标内读取，再验证受控写入/执行，并验证本地工具关闭/隔离配置。失败时保留错误、版本与复现，不杜撰“登录成功”或“已受控”。该版本无法受控时，明确禁用托管执行；可在用户授权下研究规格中的目标端 Codex 兼容模式，不私自复制本地凭证。

M0 各切片通过后，按完整规格进入 M1–M4。不要在任何原型未验证前声称产品已可做长期主力终端。

## 测试与完成标准

每个变更至少包含适用的类型/静态检查、单元测试和集成测试。修改协议必须验证 TS/Go 契约；修改安全路径必须补反例。

UI 测试必须涉及真实后台。Windows 打包、Linux PTY、SSH、Docker、ARM64、真实模型各自给独立验证状态。CI 里 FakeProvider 通过，不能代替真实 ChatGPT 登录或真实模型工具调用通过。

测试结果至少记录：执行命令、环境、依赖版本、返回结果、是否通过、未验证项。失败日志需要脱敏。

不把 TODO、空函数、静态 HTML、mock-only SSH、假退出码、假模型输出算作功能完成。

## 持续交接

每个工作单元结束前更新：

- `docs/STATUS.md`：implemented / verified / partial / blocked / not-started，区分代码状态与验证状态。
- `docs/HANDOFF.md`：当前进度、关键文件、精确启动命令、实际测试结果、已知问题、下一个最小任务。
- `docs/decisions/`：有代价的架构变更及理由。
- `docs/PROTOCOL.md`：协议/数据模型发生变更时同步。

向用户汇报时说明完成了什么、测试了什么、尚未验证什么。不要承诺后台继续工作，不给虚假的完成百分比。

**开始执行时，先检查实际仓库与环境，然后完成 M0-A 的最小垂直切片；同时建立 M0-B/M0-C/M0-D 的明确测试任务，不跳过远端与 Codex 的早期风险验证。**
