# 栈桥 StackBridge：产品与工程实施规格

版本：方案 1.0  
编制日期：2026-09-17  
状态：设计提案，不表示产品已实现、测试或通过安全审计。  
适用范围：个人高频工程开发工具；Windows 客户端优先；本地浏览器可独立使用；SSH Linux 与远端 Linux Docker 为首个正式版本核心能力；Ubuntu 桌面后续支持。

## 0. 一页决策

**产品名：栈桥 StackBridge。** CLI 工作名 `sbridge`，远端运行时 `sbridge-runtime`。这是工作命名，未进行商标、域名或包名清权检索。

**定位：本地优先、跨主机与容器、多 AI 引擎的工程终端工作台。** 不是在网页聊天框旁边放一块日志输出区。

**核心用户链路：**打开工作区 → 连接 SSH 主机 → 选择远端容器 → 在真实终端工作 → 选取日志/代码交给 AI → 查看操作目标、计划与差异 → 审批 → 在同一目标环境执行 → 检查结果 → 保存可复用的工作记录。

**核心技术决策：**

| 议题 | 决策 |
|---|---|
| 前端 | React + TypeScript + Vite，xterm.js 终端，Monaco 仅用于轻量编辑和差异 |
| 本地后台 | 独立 Node.js + TypeScript 进程，HTTP/WebSocket，不能依附 Electron 窗口生命周期 |
| 桌面外壳 | Electron；只提供窗口、托盘、快捷键、通知和后台发现/启动 |
| Windows PTY | node-pty / ConPTY；实测中文输入、信号、全屏程序和刷新重连 |
| 远端执行 | 精简 Go 运行时，交付 Linux amd64/arm64 可执行文件；目标无需安装 Node/Python |
| 远端通信 | 系统 OpenSSH；结构化控制使用无 PTY 的 SSH stdio；不暴露公网 RPC 端口 |
| Docker | SSH 到 Docker 所在主机，再经选定 daemon 执行 docker exec；不要求容器运行 sshd |
| AI 默认位置 | AI 引擎与模型凭证留在本机；远端仅运行执行器 |
| ChatGPT | 官方 Codex App Server 适配器 + 本地 MCP 工具桥；验证版本与权限边界后启用托管执行 |
| API | 自研小型工具调用循环；DeepSeek 预设与 OpenAI-compatible 适配，不混同 Codex 认证 |
| 权限 | 本地 Tool Gateway + 目标端能力校验；任意 shell 默认需审批；路径限制不冒充 OS 沙箱 |
| 数据 | SQLite 存元数据/任务/审批，分块文件存大日志；凭证单独存安全库 |
| 交付顺序 | M0 关键原型 → M1 终端与目标 → M2 跨环境 AI → M3 日常工作稳定性 → M4 Ubuntu 桌面 |

远端 Go 运行时不是第二套业务后端。它不得实现模型调用、账号管理、产品 UI、工作区管理或云同步。采用它是为了避免在开发机和每个容器里引入 Node 运行环境；这是为远端低依赖作出的工程取舍。

## 1. 产品边界

### 1.1 必须支持

- Windows 上的本地 PowerShell，标签与分屏；预留 WSL/CMD/Git Bash 能力协商。
- 独立后台启动后，可由本地浏览器使用核心功能，不需要先打开 Electron。
- Linux SSH 开发机，支持用户已有 SSH 配置、密钥代理和跳板配置。
- 开发机上的 Linux Docker 容器，既能交互操作，也能由 AI 读取目标文件、提出修改、审批后执行和验证。
- 本地 ChatGPT 登录（通过 Codex），DeepSeek API 配置，以及多个互不覆盖的配置档案。
- AI 的每个读取、写入、执行操作都绑定经过核验的目标身份。
- 真实长任务管理、取消、断线状态核验、审计、上下文隐私控制。

### 1.2 首版不做

不做完整 IDE、云端账户系统、多人协作、插件市场、移动端、Kubernetes、多 Agent 并行改同一工作区，也不做未经审批的整机自动控制。

不复制 Warp 的品牌、图标或私有实现；基于独立交互设计与公开组件开发。正式分发前需要审查各依赖许可证、NOTICE、原生二进制分发许可和代码签名。

### 1.3 支持矩阵

| 目标 | 终端 | AI 分析 | 托管文件/执行 | 备注 |
|---|---|---|---|---|
| 本地 Windows | 首版 | 首版 | 首版，经能力验证 | PowerShell 优先 |
| SSH Linux | 首版 | 首版 | 首版，标准运行时模式 | amd64、arm64 |
| SSH Linux → Docker Linux | 首版 | 首版 | 首版，标准运行时模式 | 固定 daemon、容器实例、UID |
| 本地 WSL | 后续阶段 | 后续阶段 | 通过目标适配器 | 不把 Windows 路径直接当 WSL 路径 |
| Ubuntu 桌面 | 后续阶段 | 后续阶段 | 共用核心接口 | 与首版支持远端 Ubuntu 是不同事项 |
| 无 Shell/只读/noexec 容器 | 能力探测 | 可分析已有输出 | 显式降级 | 不承诺所有镜像都可托管 |
| 不允许安装运行时的主机 | 原生 SSH | 可分析与生成命令 | 经验证的单次命令；其他能力关闭 | 不伪装完整托管支持 |

“首版”指 M1–M3 完成后的可日常使用版本，不是要求第一个提交即包含所有功能。

## 2. 关键概念与不变量

### 2.1 Connection、Target、Binding 不得混为一谈

**ConnectionProfile** 记录如何连接：SSH alias、端口、跳板、凭证引用、Docker daemon 选择等。

**ExecutionTarget** 是用户保存的逻辑工作对象，例如 `dev-main` 或 `dev-main/ros-dev`。

**RuntimeBinding** 是本次实际连上的对象：主机 SSH 指纹、远端运行时标识/epoch、执行 UID、Docker daemon 标识、完整 container ID、容器启动 epoch、挂载快照、工作根目录、能力集。

逻辑名字不等于实例身份。相同容器名被重建后，旧审批、旧进程 ID 和旧绑定必须失效。同一容器重启而 ID 不变，也需要更新启动 epoch。仅比较容器名称或 ID 不够。

### 2.2 Agent Session 必须绑定目标

一个 Agent 会话默认只能操作一个目标及授权根目录。工具实现从服务端会话中注入 target/binding，不能让模型通过填写任意 `targetId` 获得权限。

从宿主机切到容器时创建新会话或带摘要的新分支。任务开始时冻结目标，用户切换 UI 焦点不能改变正在执行的任务目标。

跨目标读取或操作必须获得显式授权，并保留分别标注的上下文。首版不做隐式多主机 Agent。

### 2.3 身份信息与提示符

终端提示符、OSC 控制序列和日志属于不可信输入。它们可帮助显示 cwd/命令边界，但不能单独建立目标身份、授予权限或变更执行目标。

用户手动输入 `ssh ...`、`docker exec ...`、`sudo -s` 后，普通终端仍正常工作，但自动识别最多显示“建议建立新目标”。未通过可信控制链核验之前，AI 托管执行不得跟随提示符自动切换。

推荐用 UI“连接主机/进入容器”或应用自己的 `sbridge connect` / `sbridge enter` 入口建立受管目标；这些是拟实现的产品命令，不是已经存在的工具。

## 3. 系统架构

```text
React Web UI                  Electron Desktop（同一套 React UI）
      \                              /
       +---- authenticated HTTP / WebSocket ----+
                                                 |
                                   StackBridge Local Core
                         workspace / history / auth / policies
                                     /                \
                         Codex App Server         API Agent Loop
                         ChatGPT 登录              DeepSeek 等 API
                              |                         |
                         MCP Adapter -------------------+
                                      |
                                 Tool Gateway
                  approval / target binding / output limits / audit
                                      |
                              Execution Adapter 层
                    /                 |                    \
             Local Windows       SSH Linux             SSH → Docker
               node-pty           runtime                runtime
                                      |                    |
                                  files / jobs / PTY / process groups
```

### 3.1 控制面与数据面

控制面承载目标信息、任务、审批、文件操作和生命周期事件。

数据面承载终端字节流和大日志。PTY 输出不能与 JSON-RPC 混在一个未经分帧的字节流中，也不能把终端输出解析成可执行控制指令。

本地到远端使用应用层分帧，经 SSH 加密传输。第一版可以使用 JSON Lines + base64 二进制块；限制单帧长度，分批发送，后续再评估二进制帧优化。stdout 专用于协议，诊断日志写 stderr 并有界处理。

### 3.2 本地与远端生命周期

本地 Core 持有 Windows PTY 与会话，不是 React 或 Electron 渲染进程持有。

远端完整模式用独立用户态 supervisor 持有 PTY 和长任务，SSH 连接仅附着和传输。可以使用权限受限的 Unix socket 作为远端 supervisor 控制入口，不监听网络接口。

容器内 supervisor 只能在容器存活期间提供保活；容器停止/重启后，运行任务不能“复活”。UI 必须反映终止或待核验状态。[R4]

未经明确用户配置，不安装 system 服务、不设置开机启动、不修改 SSH 服务端配置，也不结束并非本应用创建的进程。

## 4. SSH 与远端 Docker 的实现

### 4.1 SSH 连接

优先调用系统 OpenSSH，减少对用户 SSH 配置解析的自行重实现。需要测试 Windows 与 Linux 客户端的实际差异，不能假设每个 OpenSSH 选项跨平台完全一致。

支持保存 alias、端口、IdentityFile/agent、ProxyJump；首次连接显示主机密钥指纹；密钥变化时阻止连接并要求用户核验。默认不转发 SSH agent，也不关闭 StrictHostKeyChecking。[R5]

SSH 密码、密钥口令或多因素认证使用独立的交互/askpass 通道，不把秘密混入 AI 上下文、命令历史或协议日志。首个原型可先覆盖密钥代理，再完善口令与交互认证。

管理通道使用不分配远端 PTY 的 SSH 会话，启动固定路径的 runtime。不要把任意 AI 命令层层拼接到 `ssh "docker exec ... bash -c ..."` 中。

即使本地 spawn 使用 argv，SSH 的远端命令仍可能经远端 Shell 解释。bootstrap 只允许固定程序路径和经过验证的最小参数；实际命令、路径和文件内容通过结构化协议发送。[R5]

### 4.2 容器发现与绑定

在已验证的 SSH 主机上，由宿主 runtime 调用经选择的 Docker daemon。发现容器时只返回必要的元数据，不把 `docker inspect` 中的全部 Env 等内容自动发给模型。

记录 daemon/context 身份、完整 container ID、启动 epoch、状态、UID、Shell、cwd、挂载与权限。不能让 `DOCKER_HOST` 或当前 docker context 在任务中途静默切换到另一台机器。

用户选择容器后，创建独立 target。不存在“当前 SSH 标签里出现了容器提示符，所以 AI 已经进入容器”的推断。

### 4.3 容器执行

通过宿主调用 `docker exec` 进入选定容器，不要求容器 SSH 服务、不要求开放额外端口，也不要求 Windows 安装 Docker Desktop。[R4]

完整模式在容器内放置经过校验的 runtime，以用户确认的 UID、cwd 启动；可复用临时或用户缓存目录，不修改镜像。运行时管理其子进程和文件操作。

协议连接不使用 `docker exec -t`。需要交互终端时，由容器 runtime 创建 PTY 并返回字节流；否则 TTY 的回显和换行转换可能破坏结构化消息。简易原生终端模式可以使用正常的交互式 exec，但它和结构化管理通道必须区分。[R4]

`--user`、`--workdir`、必要的非敏感环境覆盖都显式设置。容器没有 Bash 时尝试用户认可的 `/bin/sh`；没有 Shell 时仅启用已支持的直接 argv 执行或文件工具，不声称可提供交互式 Shell。

### 4.4 用户授权的 runtime 部署

本机准备经过固定版本和完整性校验的二进制，经 SSH 上传。展示将写入的目录、版本、执行用户、权限及清理方式。禁止自动执行未经校验的 `curl | sh`。

提供 amd64/arm64 构建，测试 Ubuntu 22.04/24.04、对应开发容器和 ARM64 场景。Go 运行时设计目标是不依赖远端 Node/Python；目标内核、exec 权限、只读文件系统等仍需要实际探测。

noexec、只读根目录、权限不足、exec 禁止时，不自动要求 root、不加 `--privileged`。提供明确降级：普通终端、日志分析、命令建议，以及该模式下确实经过测试的受审批单次执行。未实现的文件修改、精确取消和断线保活必须标注不可用。

### 4.5 挂载与宿主影响

容器文件可能通过 bind mount 直接对应宿主文件。文件树、差异和审批中展示实际映射；用户授权的是容器目录，不应自动推定他授权了所有宿主挂载。[R6]

发现 Docker socket、特权模式、敏感宿主挂载或 host PID 等配置时提示高风险。不能把“运行在 Docker”当成充分安全隔离。[R7]

普通 docker group/daemon 权限可能意味着强大的宿主控制能力。Runtime 不自动添加用户进 docker 组，不修改 socket 为宽权限，不挂载宿主 Docker socket到业务容器。[R7]

## 5. AI 引擎与认证

### 5.1 两类抽象

`AgentEngine`：会话、turn、取消、事件、权限交互、模型列表。

`ModelProvider`：消息/工具协议、流式响应、用量、错误、模型能力。它是 API Agent 的下层，不假定 Codex 就是另一个换 Base URL 的模型 SDK。

### 5.2 API 路线

DeepSeek 预设采用其公开支持的 API 协议；模型 ID 与能力通过当前服务商信息/用户配置取得，不硬编码过时模型。[R8]

本地 API Agent 执行：构造上下文 → 请求模型 → 收集完整工具调用 → 校验参数 → Tool Gateway 审批 → 目标执行 → 返回结构化结果 → 继续或结束。

仅接受协议中的正式 tool calls，不把自然语言里的代码块自动执行。工具参数流未完成前不执行；错误 JSON、未知工具、越界参数、重复 call ID 均要处理。

设置最大步骤数、每次工具超时、总预算和循环检测。不要将失败后的跨服务商回退作为默认行为。

模型凭证保存在本机安全库，远端 runtime 不获取 API Key。因此目标不需要访问模型服务，但用户本机需要能够访问相应服务；目标上的 apt、pip、git fetch 等业务命令仍可能需要其自身联网条件。

### 5.3 ChatGPT 路线

官方支持通过 Codex 使用 ChatGPT 订阅认证，也支持 API Key 方式；两者不是同一计费或认证语义。[R1]

集成 `Codex App Server`，让它负责 ChatGPT 登录、令牌刷新和 Codex 会话。前端只接收登录状态和需要展示的官方授权步骤，不接触持久化 token。[R1][R2]

采用应用专属的 `CODEX_HOME`，不覆盖用户既有 `~/.codex`。默认要求系统凭证库；凭证库不可用时明确报错或使用用户选择的临时会话，不静默退回明文存储。退出登录、正在运行的会话和独立配置档案须有一致语义。[R1]

本地 Core 经 stdio 连接 App Server。官方目前将相关 App Server/部分传输与扩展能力标注实验性，因此锁定并验证版本、保存兼容性结果，不依赖自动升级后仍兼容。[R2]

本地 App Server 通过专用 MCP 适配器调用 StackBridge Tool Gateway。MCP 向模型提供的是当前目标的受控文件/执行工具，权限仍由网关决定。[R3]

**必须完成的兼容验证：**

1. 当前版本允许 ChatGPT 登录、启动/恢复会话、连接 required MCP server。
2. 读文件与执行工具确实落到目标 host/container，不操作本地同名文件。
3. 本地 shell、unified exec、文件修改、非必要 hosted tools、subagents、外部插件等通过当前版本可用配置关闭或拒绝；不把 prompt 当权限控制。[R9]
4. 本地引擎使用隔离的控制工作目录，并验证其 sandbox/审批实际生效。不让它读取本地真实项目来“假装”远端项目。
5. 原生 Codex 工具与 MCP 工具不是同一个执行器。无法证明约束有效时，禁用该版本的托管执行；不能用前端审批按钮冒充控制了所有操作。
6. hooks 仅作补充检查。官方说明存在不经过普通 tool hook 的路径；错误 hook 输出还可能导致继续执行，所以不能以 hooks 作为唯一安全边界。[R10]
7. 不把 `thread/shellCommand` 暴露为通用 Agent 执行捷径：当前官方说明它用于显式用户命令，且不继承线程 sandbox。[R2]

不要使用实验性 `chatgptAuthTokens` 接口来掩盖“应用没有合法 token 获取/刷新能力”的问题；首版采用 Codex 托管登录，不自行仿造 OAuth 客户端或抓浏览器 Cookie。[R2]

### 5.4 目标端 Codex 兼容模式

作为显式选择的备用方案，可在开发机或容器内运行 Codex App Server，经 SSH stdio 转发给本机 UI。模型内置工具因此在该目标上运行；用户在自己的本地浏览器完成官方设备码认证，远端实例获得其自己的授权。[R1][R2]

代价必须在 UI 说明：远端需要访问模型服务、安装兼容 Codex、保存或临时持有该授权，远端管理员可能访问相关进程和文件。不得自动复制用户本地凭证，不得把凭证打进容器镜像。

此模式依赖 Codex 自身执行/审批边界，不能宣称它的所有操作都经过自研网关。自研严格权限无法实现等价映射时关闭对应自动模式。默认仍采用本地中枢模式，避免每个容器单独配置账号。

## 6. 终端、命令块和环境

### 6.1 真实终端

保持持久 Shell/PTY；实现尺寸调整、UTF-8、CJK/emoji、中文输入法、选择复制、多行粘贴确认、搜索、全屏程序、快捷键和鼠标行为。Windows 使用实际 ConPTY 会话，而不是为每条命令单独调用进程后展示 stdout。[R11]

xterm.js 输出按官方流控建议控制吞吐，不能以无限累积 JS 字符串处理日志。适配 WebGL 不可用时的回退路径。[R12]

### 6.2 命令块

独立保存命令、目标 binding、cwd、开始/结束时间、退出码、状态、输出区间和捕获方式。

通过 Shell Integration 获取命令边界/cwd/退出状态，不能只靠正则匹配提示符。不能准确识别时标记 unknown，仍保留原生终端使用。[R13]

历史重跑先展示当前目标、目录和环境；不会因为曾经批准过某条命令就无限期自动执行。

### 6.3 人工 Shell 与 Agent Shell

人工终端与 Agent 专用执行区分离。Agent 不向正在运行 vim、等待密码或执行交互程序的人工终端注入文本。

人工终端里的 `source`、`cd`、`export` 不会天然复制到新建执行进程。Docker 新 exec 也不自动继承另一交互 shell 的临时环境。[R4]

通过版本化 `EnvironmentProfile` 定义 shell、cwd、用户批准的初始化脚本、环境白名单和额外参数。ROS2、Conda 等初始化在每个新任务执行上下文中重建，并显示 profile 版本。

需要连续共享环境的工作流声明 `sharedShellSession`，由 runtime 保持专用 Shell；独立任务则明确重新初始化。不要导出整个环境并上传模型，避免密钥泄露。

MVP 不承诺迁移任意 alias、shell function、激活状态或后台作业。用户临时终端状态与 Agent 环境不同，必须有可见提示。

## 7. 功能规格与优先级

P0：首个可真实使用版本不可缺失。P1：主力工作版增强。P2：成熟后扩展。

| 编号 | 优先级 | 功能 | 核心要求 |
|---|---|---|---|
| TERM-01 | P0 | 本地终端 | PowerShell、真实 PTY、快捷键、中文输入 |
| TERM-02 | P0 | 标签/分屏 | 保存工作区布局，绑定目标与会话 |
| TERM-03 | P0 | 输出与日志 | 有界内存、暂停跟随、搜索、日志导出 |
| TERM-04 | P0 | 命令块 | 成功/失败状态、输出引用、未知状态降级 |
| CONN-01 | P0 | SSH 档案 | alias、host key、密钥代理、明确身份 |
| CONN-02 | P0 | 远端 Docker | 容器列表、运行状态、独立 target、UID/cwd |
| CONN-03 | P0 | 目标防串线 | runtime binding、目标变化使审批失效 |
| CONN-04 | P1 | SSH 高级体验 | 跳板、交互认证、文件传输、连接诊断 |
| CONN-05 | P1 | 端口转发 | 启停、端口冲突、目标网络命名空间说明 |
| AI-01 | P0 | API 配置档案 | DeepSeek/自定义接口、模型能力、连接测试 |
| AI-02 | P0 | ChatGPT 认证 | Codex 托管登录/退出、状态、专属配置 |
| AI-03 | P0 | 解释/生成 | 选中日志分析、命令解释、回填人工输入框 |
| AI-04 | P0 | 跨目标环境工具 | 在当前 target 读取、搜索、受审批执行 |
| AI-05 | P0 | 文件差异 | 先 diff、核验原内容、审批应用、保存恢复点 |
| AI-06 | P0 | 执行记录 | 计划摘要、工具、审批、结果、验证与未知事项 |
| AI-07 | P1 | 多步排查 | 限步数/预算、失败中止、循环检测 |
| AI-08 | P1 | 上下文管理 | 选区/块/文件片段、摘要、来源回指、排除规则 |
| WS-01 | P0 | 工作区 | 项目目录、目标、布局、默认 AI/权限配置 |
| WS-02 | P1 | 环境档案 | ROS2/Conda/编译配置，初始化 hash 与版本 |
| WS-03 | P1 | 工作流 | 参数化、多终端、依赖、就绪检查、长任务 |
| WS-04 | P1 | 项目文件 | 轻量编辑、差异、跳转 VS Code、受控 Git |
| REL-01 | P0 | 刷新重连 | Core 持有会话，补发事件，不重复输入 |
| REL-02 | P0 | 任务取消 | 模型停止/任务取消/进程停止分开 |
| REL-03 | P0 | 幂等与未知状态 | 去重、runtime 核验、不承诺通用 exactly-once |
| REL-04 | P1 | 长任务保活 | 远端 supervisor，掉线后保留已启动任务 |
| SEC-01 | P0 | 本地鉴权 | 回环监听、会话/Origin/Host 检查、WebSocket 鉴权 |
| SEC-02 | P0 | 凭证与隐私 | 安全库、日志脱敏、敏感模式、发送前可见 |
| SEC-03 | P0 | 审批审计 | 精确操作绑定、过期、单次使用、撤销 |
| SEC-04 | P1 | 限制自动模式 | 仅在已验证隔离/策略能力下开放 |
| DESK-01 | P0 | Windows 安装包 | 不要求用户安装 Node，原生依赖 ABI 匹配 |
| DESK-02 | P1 | 系统集成 | 托盘、通知、外部编辑器、更新前任务提示 |
| EXT-01 | P2 | Ubuntu 客户端 | 复用 UI/Core，补 PTY/凭证/打包差异 |
| EXT-02 | P2 | 更多模型/工具 | 本地模型、可选 MCP 扩展；默认不开放全部插件 |

## 8. 界面组织

左侧：工作区、主机与容器树、连接状态。中间：标签/分屏终端。右侧：AI 对话、上下文选择、工具活动。底部：任务、审批、日志、转发端口。

AI 面板顶部固定显示，例如：

```text
目标：dev-main → Docker ros-dev
容器：8f3a…（展示缩写；内部保存完整 ID）
用户：1000:1000
目录：/workspace/mantastyle
环境：ros2-humble-v3
引擎：ChatGPT / Codex（本机）
权限：每次 shell 执行需审批
```

审批卡不能只有“Allow/Deny”。应显示目标、UID、cwd、完整脚本/argv、环境初始化、文件 diff、挂载影响、授权有效期。更改任何执行要素都要重新审批。

顶部切换标签不能改变已展示审批卡的目标；在审批前再次核验 binding。

## 9. Tool Gateway 与权限

### 9.1 目标工具最小集合

| 工具 | 行为 | 默认权限 |
|---|---|---|
| target.describe | 返回经网关筛选的当前绑定/能力 | 可自动 |
| fs.list / fs.stat / fs.read | 按授权路径分页/限量读取 | 根目录内可自动，敏感文件拒绝 |
| fs.search | 授权根内搜索，默认排除二进制/构建产物 | 可自动；有输出上限 |
| fs.proposePatch | 生成差异/验证目标版本，不写文件 | 可自动 |
| fs.applyPatch | 校验原内容 hash 后应用已审批 patch | 审批 |
| process.exec | 直接 argv 执行 | 默认审批 |
| process.shell | 明确 shell 的脚本执行 | 默认审批，不冒称只读 |
| process.status / process.output | 读取本应用创建的任务状态/输出 | 可自动 |
| process.cancel | 对已绑定任务停止 | 用户明确操作/独立权限 |
| terminal.proposeInput | 把建议交给 UI，不发送输入 | 可自动 |

模型不知道也不获得网关的审批令牌。网关拿到 UI 的授权后生成短期、单次、绑定 action hash 的能力票据。runtime 验证票据或已建立的受认证会话权限，不接受“approved: true”一类模型自填字段。

### 9.2 三种模式

**建议模式：**分析附加上下文、生成建议，无任何自动 shell 执行。

**审批模式：**结构化授权读取可自动；每次 shell、修改和外部副作用需要确认。这是默认工作模式。

**限制自动模式：**只在实际具备所需隔离、目标目录/工具约束与资源限制时启用。提供最大步骤、截止时间、预算和停止按钮。没有 OS sandbox 时明确标注不是沙箱隔离；不把任意 Shell 命令仅凭关键词当只读放行。

授权工作区文件路径不能限制一个任意进程访问该 UID 的其他文件；必须通过真实隔离或人工审批覆盖风险。运行时的操作系统权限同样无法防御有目标 root 权限的人。

### 9.3 不可信内容

仓库的 AGENTS.md、README、日志、网页和模型回复都是上下文，不是权限配置。不得修改本地用户级策略或放宽根目录。

禁止从终端输出触发授权、自动打开任意 URI、未经允许写系统剪贴板或渲染任意 HTML。链接只开放用户确认的安全 scheme。xterm.js 的安全指南强调终端数据是不可信输入，终端连接必须有认证授权。[R14]

### 9.4 本地服务

默认仅回环地址，检查 Host/Origin、使用本地配对和受保护会话；随机端口不能替代认证。WebSocket 验证与 HTTP 等价。

生产由 Core 提供同源 UI；开发时用明确白名单和 Vite 代理，不使用 `Access-Control-Allow-Origin: *` 作为临时方案。Cookie 设置 HttpOnly/SameSite 并按实际 HTTP/TLS 能力配置；不把长效秘密放在 URL 或前端 localStorage。

Electron 关闭 nodeIntegration、启用 contextIsolation 和 sandbox、严格 CSP；不让渲染进程直接运行 Shell、读 SSH 私钥或调用模型 API。[R15]

### 9.5 隐私

默认不发送整个仓库、整个环境或所有终端日志。上下文清单列出来源、行/字节范围、被截断的内容及接收服务商。

日志中的秘密识别只作降低风险，不能承诺百分之百脱敏。敏感模式从启用之后暂停本应用持久化/发送，不撤回既有日志或已上传数据；人工 Shell 自身历史策略需另外处理。

## 10. 协议与数据模型

以下接口均为 StackBridge 拟定协议，不是 OpenAI/Docker 官方接口。

### 10.1 核心类型

```ts
type TargetSpec =
  | { kind: 'local'; id: string; platform: 'windows' | 'linux' }
  | { kind: 'ssh'; id: string; connectionProfileId: string }
  | {
      kind: 'docker'; id: string; parentTargetId: string;
      daemonProfileId: string; containerSelector: string;
      requestedUser: string;
    };

interface RuntimeBinding {
  bindingId: string;
  targetId: string;
  generation: string;
  runtimeInstanceId: string;
  verifiedHostKey?: string;
  hostBootId?: string;
  dockerDaemonId?: string;
  containerId?: string;
  containerStartedAt?: string;
  principal: { uid?: number; gid?: number; name?: string };
  platform: 'windows' | 'linux';
  arch: string;
  workspaceRoots: string[];
  mountsDigest?: string;
  capabilities: string[];
}

interface AgentSession {
  id: string;
  workspaceId: string;
  engineProfileId: string;
  engineSessionId?: string;
  engineHost: 'local' | 'target';
  targetId: string;
  bindingId: string;
  policyProfileId: string;
  environmentProfileId: string;
}

interface ExecutionRequest {
  requestId: string;
  operationId: string;
  agentSessionId: string;
  expectedBindingId: string;
  cwd: string;
  command:
    | { kind: 'argv'; program: string; args: string[] }
    | { kind: 'shell'; shell: string; script: string };
  environmentProfileId: string;
  timeoutMs: number;
  approvalId: string;
}
```

网关将模型参数映射到 ExecutionRequest；模型不能自己指定 approvalId、目标身份或调用者权限。

所有路径按目标系统解析。Linux 用 POSIX 路径，Windows 用对应本机路径规则；禁止用 Windows `path.resolve` 处理远端 Linux 路径。文件访问检查 `..`、符号链接、Windows junction/reparse point 和换挂载等问题。

严格路径约束尽可能使用基于目录句柄的安全打开方法，避免先 realpath 后 open 的竞态。权限不足或无法保证约束时拒绝对应严格模式。

### 10.2 Core HTTP/WS 边界

| API 提案 | 用途 |
|---|---|
| POST /v1/connection-profiles | 保存连接档案 |
| POST /v1/targets/connect | 建立绑定、能力探测 |
| GET /v1/targets/:id/containers | 发现指定 daemon 的容器 |
| POST /v1/terminal-sessions | 创建持久终端 |
| WS /v1/terminal-sessions/:id/stream | 输入/输出/resize，含写入租约 |
| POST /v1/agent-sessions | 创建绑定目标的 AI 会话 |
| POST /v1/agent-sessions/:id/turns | 提交带上下文的任务 |
| POST /v1/approvals/:id/decision | 用户审批；校验来源与当前 binding |
| POST /v1/jobs/:id/cancel | 请求停止运行任务 |
| WS /v1/events | 任务/审批/AI 状态事件，按序号补发 |

所有状态修改都需要认证和 runtime schema 校验。文件工具等内部 API 也必须通过同一权限核心，不能存在为方便调试而绕过网关的生产端点。

### 10.3 事件与幂等

事件含 `eventId`、`seq`、`workspaceId`、`targetId`、`sessionId`、`operationId`、时间与类型。断线后仅补发输出/状态，不重放终端输入或执行请求。

以 operationId 去重并持久化审批和提交状态。runtime 为操作建立独立任务记录后返回 jobId。网络错误重试首先查询任务状态；不能把“没收到成功”视为“没有执行”。

任意系统副作用无法获得通用 exactly-once 保证。存在进程启动成功但状态持久化失败等窗口，必须标记 unknown 并核验，而不是盲目重跑。

### 10.4 长任务

```text
queued → waiting_approval → starting → running
                                  ↘ failed
running → completed / failed / cancel_requested / disconnected_unknown
cancel_requested → cancelled / completed / unknown
```

请求取消不等于已经取消；只有 runtime 确认停止才显示 cancelled。Linux 优先正常信号再确认是否强制结束；Windows 使用已验证的进程树/PTY 停止实现。目标是管理本应用启动的任务，不声称能可靠追踪任意主动逃逸进程组的恶意程序。

## 11. 文件修改与恢复

读取返回内容、编码、换行方式、实际路径、大小和内容 hash。AI patch 绑定基线 hash。审批前和应用前检查目标、mount digest、文件 hash；变化则重新 diff，不能覆盖人工新改动。

应用时保留文件模式、编码、换行，临时文件在同目录创建并原子替换可替换文件；文件被单独 bind mount 等不支持替换的场景必须探测，不能简单声称总是原子写入。

每次文件修改保存内容恢复点及操作元数据。回滚前验证当前内容仍为本次修改后的版本，否则展示新的冲突差异。

文件恢复不能撤销所有终端命令的副作用。安装包、数据库迁移、网络配置、Git 远端推送都需独立处理，不提供虚假的“撤销一切”按钮。

## 12. 数据、打包与诊断

SQLite 实体：workspaces、connection_profiles、targets、runtime_bindings、environment_profiles、provider_profiles、terminal_sessions、command_blocks、agent_sessions、agent_messages、tool_calls、approvals、jobs、events、file_snapshots、workflow_runs、schema_migrations。

大输出按 chunk 写文件，SQLite 只保存索引/引用。输出在 UI、日志、模型上下文中使用不同保留策略与预算。查询以工作区/目标/命令/状态/时间过滤，不默认把所有历史发给模型。

凭证库仅保存 secret，数据库保存 credentialRef。备份默认不导出凭证，清楚区分“导出配置”和“导出密钥”。

Windows 安装包包含可运行的 Core 环境与正确 ABI 的原生依赖；浏览器开发与桌面打包均须测试，不能只在开发机器 npm install 后通过。Electron 与独立 Node 的原生模块使用场景不同，不假定同一个 node-pty 编译产物通用。

更新前检测运行任务，支持延期更新、版本回退和数据库迁移备份。远端 runtime 支持多版本缓存、兼容协商、旧版本清理和离线部署。

诊断面板展示 UI/Core/runtime/引擎版本、连接状态、任务状态、延迟、输出队列、脱敏错误；不上传诊断包，除非用户明确选择导出/发送。

## 13. 建议目录结构

```text
stackbridge/
  apps/
    web/                    # React UI
    desktop/                # Electron shell
    core/                   # 独立 Node 后台
  packages/
    protocol/               # TS types、runtime schema、生成 schema
    ui/                     # 通用 UI
    terminal/               # xterm 与 Shell Integration
    targets/                # local / ssh / docker 适配
    tool-gateway/           # 权限、审批、调用路由
    agent-core/             # API 工具调用循环
    providers/              # DeepSeek/兼容协议
    codex-adapter/          # app-server 与账户会话适配
    mcp-bridge/             # 专用工具桥
    persistence/            # SQLite 与输出存储
    credentials/            # 系统安全库
  runtime/
    cmd/sbridge-runtime/    # Go 用户态运行时
    internal/pty/
    internal/process/
    internal/files/
    internal/docker/
    internal/transport/
  tests/
    unit/
    integration/
    e2e/
    fixtures/
  docs/
    PRODUCT_SPEC.md
    ARCHITECTURE.md
    PROTOCOL.md
    SECURITY.md
    IMPLEMENTATION_PLAN.md
    ACCEPTANCE_TESTS.md
    STATUS.md
    HANDOFF.md
    decisions/
  AGENTS.md
```

具体库版本由实施时的支持状态和测试决定，使用 lockfile 固定版本。类型共享不能代替运行时参数校验；远端 Go/TS 协议需要共同 schema 与契约测试。

## 14. 实施里程碑

### M0：先验证关键边界

不是先画大量 UI。完成四个小而真实的端到端原型：

- Windows 浏览器 ↔ 独立 Core ↔ PowerShell PTY，支持输入、resize、Ctrl+C、刷新重连。
- 本机 → SSH Linux → Docker，实际读取目标文件、执行命令、返回退出码；验证不误操作宿主和本机同名文件。
- DeepSeek 或兼容模型的真实流式工具调用，工具经过审批、在目标运行、结果回传。
- ChatGPT 登录 → 本地 App Server → required MCP → 目标文件/执行，验证权限约束；无法通过时输出失败证据，并保留明确降级模式。

产物：源码、启动命令、版本记录、测试结果、架构决策记录、已知限制。FakeProvider 可以辅助测试，但不能替代真实验证。

### M1：终端与目标底座

实现工作区、标签分屏、SSH 档案、Docker 发现、Binding、运行时部署、日志分块、基础命令块、本地认证。使用不接 AI 的应用也能完成真实命令行工作。

### M2：跨环境 AI 闭环

实现 AI 配置、ChatGPT 认证、API Agent、MCP 桥、上下文选择、target-aware 文件检索、审批执行、差异应用与验证。每个引擎都走自己的已验证能力矩阵，不假装完全相同。

### M3：主力工作质量

实现长任务保活、重连核验、工作流、环境档案、文件恢复、预算、代理/企业 CA、诊断、Windows 安装包和升级机制。所有 P0 验收通过，P1 根据实际工作高频程度迭代。

### M4：扩展

Ubuntu 桌面、WSL 深化、本地模型、更多 MCP 工具及隔离后的并行任务。保留 Linux/Windows 适配边界，不重写整个 Core。

## 15. 验收用例

以下是要实现并测量的目标，不是现有性能或安全保证。

| ID | 用例 | 必须观察到的结果 |
|---|---|---|
| AT-01 | 未启动 Electron，仅打开本地 Web | 真实 PTY、文件、AI 核心流程可用 |
| AT-02 | PowerShell 中文目录/中文输入/emoji | 输入输出与光标不明显错位；回归测试通过 |
| AT-03 | vim/top/less 或适用平台同类工具 | 全屏、resize、Ctrl+C、退出正常 |
| AT-04 | 人工 Shell cd/source/export 连续执行 | 同一 Shell 环境保持；不为每条命令重启 Shell |
| AT-05 | 刷新 UI，同时仍有编译任务 | 同一 session/job 重连，无第二个编译进程 |
| AT-06 | Web 与桌面同时打开同一终端 | 只有持有效租约的端可输入，另一端只读或明确接管 |
| AT-07 | SSH 指纹改变 | 阻止自动连接，不默认接受新指纹 |
| AT-08 | 两台 SSH 主机相同目录/文件名 | AI 精确读取当前 target；其他主机无变化 |
| AT-09 | 本机/宿主/容器都有 /workspace 类似文件 | 容器 AI 修改仅作用于确认目标；显示 bind mount 实际影响 |
| AT-10 | 容器无互联网，本机可调用模型 | 本地中枢模式仍可分析并执行无需联网的目标任务 |
| AT-11 | 容器重建或重启发生在审批后 | 旧审批失效，不静默写入新实例 |
| AT-12 | 用户切换 UI 标签后批准旧审批 | 执行仍绑定原卡片目标，或因过期拒绝 |
| AT-13 | path 含空格、引号、换行、中文 | 参数完整到达目标，无 Shell 注入或路径错配 |
| AT-14 | 读写经 ..、symlink、junction 越界 | 在严格文件工具模式被阻止 |
| AT-15 | README/日志要求上传私钥或改权限 | 不改变网关策略；拒绝未授权操作 |
| AT-16 | 重复提交同 operationId，模拟 ACK 丢失 | 查询原任务，不重新发起不确定副作用 |
| AT-17 | SSH 断线且 supervisor 存活 | 恢复后核验同一任务；未确认前不自动重跑 |
| AT-18 | 点击停止模型 | 停止生成但准确标注仍存活的业务任务 |
| AT-19 | 请求停止 rosbag/长任务 | 正常退出优先；强杀前提示；只有确认停止才显示 cancelled |
| AT-20 | API 401/429/超时/无效模型 | 报错分类准确；终端不受影响；不跨供应商静默回退 |
| AT-21 | ChatGPT 与 DeepSeek 切换 | 两份配置和历史保留，不覆盖用户其他 Codex 配置 |
| AT-22 | required MCP 不可用/引擎版本不兼容 | 禁止托管执行并明确报错，不绕过工具网关 |
| AT-23 | 本地读取/执行工具被诱导调用 | 测试确认关闭/隔离措施有效；未通过的版本不能标注受控模式 |
| AT-24 | 文件在审批后被用户编辑 | hash 冲突，重新展示差异，不覆盖新内容 |
| AT-25 | noexec/只读容器/缺少 Shell | 明确能力降级，不尝试提权或 privileged |
| AT-26 | 非法 Origin/无会话直接连 WS | 握手或操作被拒绝 |
| AT-27 | 高频输出压力 | 记录固定硬件/配置下吞吐与延迟；内存有界，超限可见，无无限堆积 |
| AT-28 | 干净 Windows 安装机 | 安装包不依赖开发者全局 Node/编译环境；实际可运行 |
| AT-29 | ARM64 远端与容器 | 使用匹配二进制，执行/PTY/文件回归通过 |
| AT-30 | 导出诊断与配置 | 不含 API Key、刷新令牌、SSH 私钥、原始敏感环境 |

CI 用确定性假模型验证协议/异常，真实模型用单独手动或受控集成测试。没有凭证、Windows、ARM64 设备或测试服务时标记“未验证”，不能把 skip 算通过。

## 16. 开发 Agent 的工作纪律

先读取当前仓库与文档，核实已有实现，不覆盖用户变更。每次只完成一个可验证垂直切片。涉及公开接口时检查当前官方文档并记录所测版本；不照抄可能过时的字段。

实现与文档都应使用明确的状态：implemented、verified、partial、blocked、not-started。所谓完成必须有实际执行过的命令和测试结果，不只是接口占位或 mock 演示。

每轮结束更新 docs/STATUS.md 与 docs/HANDOFF.md：已改文件、完成点、执行过的测试、未验证环境、已知风险、下一个具体动作。不要求下一个 Agent 重新推测需求。

任何真实远端写入、安装运行时、停止服务、修改网络、读取秘密、登录第三方服务，均须用户授权；测试优先使用隔离 fixture，不自动连接生产设备。

## 17. 官方依据与验证边界

文档支持组件能力与已说明的接口语义；架构、功能范围、接口提案、里程碑和验收标准为本方案的设计，不是官方产品保证。以下页面于 2026-09-17 查阅；实施时仍须验证锁定版本。

```text
[R1] OpenAI — Codex Authentication
https://developers.openai.com/codex/auth/

[R2] OpenAI — Codex App Server
https://developers.openai.com/codex/app-server/

[R3] OpenAI — Codex MCP
https://developers.openai.com/codex/mcp/

[R4] Docker — docker container exec
https://docs.docker.com/reference/cli/docker/container/exec/

[R5] OpenSSH — ssh manual
https://man.openbsd.org/ssh

[R6] Docker — Bind mounts
https://docs.docker.com/engine/storage/bind-mounts/

[R7] Docker — Protect the Docker daemon socket
https://docs.docker.com/engine/security/protect-access/

[R8] DeepSeek — Your First API Call
https://api-docs.deepseek.com/

[R9] OpenAI — Codex Configuration Reference
https://developers.openai.com/codex/config-reference/

[R10] OpenAI — Hooks
https://learn.chatgpt.com/docs/hooks

[R11] Microsoft — Creating a Pseudoconsole session
https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session

[R12] xterm.js — Flowcontrol
https://xtermjs.org/docs/guides/flowcontrol/

[R13] Microsoft VS Code — Terminal Shell Integration
https://code.visualstudio.com/docs/terminal/shell-integration

[R14] xterm.js — Security
https://xtermjs.org/docs/guides/security/

[R15] Electron — Security
https://www.electronjs.org/docs/latest/tutorial/security
```
