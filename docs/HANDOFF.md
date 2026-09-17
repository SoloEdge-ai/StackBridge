# 当前交接

更新日期：2026-09-18

## 已完成

- 建立 StackBridge 本地 Git 仓库。
- 将原始规格与交接材料保存在 `docs/design/`。
- 增加项目首页、设计评估和诚实的状态矩阵。
- 建立 `SoloEdge-ai/StackBridge` 私有远端并推送 `main` 分支。
- 建立 pnpm workspace、React/Vite Web、独立 Node.js Core 和共享协议包。
- Core 仅监听 `127.0.0.1`，校验 Host/Origin，以启动令牌换取 HttpOnly/SameSite 本地会话。
- 使用 node-pty/ConPTY 持有真实 PowerShell，会话由 Core 管理，不随网页刷新销毁。
- Web 使用 xterm.js，支持输入、resize、Ctrl+C、session ID 重连与最多 1 MiB 输出回放。
- 同一终端采用单写者租约：首个页面可写，其余页面只读且可显式接管；写者断开后自动转交。
- 浏览器认证会话、终端会话、Core WebSocket 待发送量和 Web 渲染队列均设有上限。
- 增加协议、会话、HTTP/WS 和真实 Windows PTY 测试。
- 建立 ConnectionProfile、ExecutionTarget、RuntimeBinding 与 ExecutionRequest 的版本化严格 schema。
- 增加覆盖本地、SSH、Docker、argv 与 shell 的语言无关 JSON 契约 fixture，并记录目标身份 ADR 与威胁检查。
- 增加 Linux Go runtime：JSON stdio 握手、主机 argv、Docker inspect/exec、输出上限及容器 binding 复核。
- 增加 Core SSH runtime client：系统 OpenSSH、严格 host-key 校验、固定 runtime 路径、指纹捕获、结构化请求和响应上限。
- 在 `friden-dev-cube` 的真实 Ubuntu 22.04 amd64 宿主与 Ubuntu 22.04 容器上完成 M0-B1 集成验证，包括容器重建后的旧 binding 拒绝。
- 增加 M0-B2 runtime 自动同步：无需远端预装 runtime 即可完成 host-key pin、Linux/架构探测、SFTP 上传、SHA-256 校验、内容寻址安装、原子 `current/previous` 切换和失败回滚。
- Go runtime 升级为协议 2，握手公开 runtime 版本和当前二进制摘要，并增加 `version`、`install`、`rollback` 固定模式。
- 内置 linux/amd64 与 linux/arm64 静态 runtime；Core 启动时加载并校验本地产物，远端无需 Go、Node 或 Python。
- Web 增加 SSH/Docker 工作区：绑定目标与提案的一次性部署确认、连接状态、核验身份、手动结构化 argv 输入、超时和 stdout/stderr 结果。
- 通过真实浏览器、真实 `friden-dev-cube` 和已标签 Ubuntu 22.04 Docker fixture 验证 UI 连接和执行；再次连接会静默复用匹配 runtime。

## 当前边界

M0-A、M0-B0、M0-B1 和 M0-B2 最小垂直切片可用，但仍是开发原型。没有 Electron、持久化层、AI provider 或 Codex 集成；runtime 已自动部署/升级/回滚并校验 SHA-256，但正式发布签名尚未实现。已验证一套 Ubuntu 22.04 amd64 SSH/Docker fixture；Ubuntu 24.04 仅完成静态 runtime 容器兼容性冒烟，尚未验证完整 SSH 部署。物理 ARM64、跳板机、远端 PTY 和正式安装包仍未验证。

## 启动与验证

```powershell
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173`，输入 Core 控制台打印的启动令牌。

```powershell
pnpm typecheck
pnpm test
pnpm build
```

已验证环境：Windows NT `10.0.26200.0`、Node.js `22.14.0`、pnpm `10.33.0`、node-pty `1.1.0`、PowerShell/ConPTY；远端 Ubuntu 22.04.5 LTS amd64、Docker Engine `29.4.0`、Ubuntu 22.04 容器、Go `1.24` 隔离构建容器。

## 已执行的验证

- 共享协议 schema：合法输入/resize/写入租约/ready/output 与非法边界。
- 目标协议 schema：ConnectionProfile、ExecutionTarget、RuntimeBinding 与 ExecutionRequest 的本地/SSH/Docker/argv/shell 变体，以及严格未知字段拒绝。
- 跨语言 fixture：TypeScript 与 Go runtime 均解析同一份 `m0-b0-target-contract.json`。
- 真实 SSH：严格 host-key、连接指纹、runtime/boot/principal 身份、固定路径启动、普通 argv 与复杂字符保持。
- 真实 Docker：显式 context、daemon/full container ID/start time/UID/GID/cwd/shell/mount digest 绑定，同名文件防串线，重建同名容器后旧 binding 返回 `stale_binding`。
- runtime 部署：缺失时先返回确认提案；批准后写入 `/home/friden/.sbridge`，摘要与握手匹配；第二次无批准连接复用相同版本。
- 部署授权：一次性授权绑定 SSH/Docker 请求与完整提案；目标、主机指纹、版本或摘要改变后拒绝沿用旧授权。
- 资源与路径边界：远端会话最多 16 个；runtime 安装拒绝 staging 或内容寻址目录的中间符号链接逃逸。
- 真实远端 UI：在浏览器中完成 SSH 宿主与 Docker 容器连接，显示 runtime/架构/部署状态，并分别执行 `/usr/bin/uname -a` 返回目标内结果。
- 会话生命周期：断开订阅后 PTY 保持、回放有界、UTF-8 边界安全、退出后拒绝写入、终端数量上限。
- Core HTTP/WS：Origin、启动令牌、HttpOnly cookie、创建终端、输入/resize、单写者接管、刷新重连回放；错误 Origin 和缺失 cookie 的 WebSocket 升级会被拒绝。
- 浏览器认证会话：8 小时服务端过期、最多 32 个会话并淘汰最早记录。
- 真实 Windows PTY：同一 Shell 环境变量保持、UTF-8 中文与 emoji、真实 resize、Ctrl+C 中断长任务。
- 真实浏览器：认证、创建终端、刷新前后保持同一 session ID；Core 重启后的旧 session 会转为可恢复状态并可一键新建终端；浏览器控制台无错误。

尚未验证中文输入法组合态、vim/top 等全屏 TUI、持续高吞吐压力和打包后的干净 Windows 环境；这些不属于当前“verified”声明。
当前 Web 生产包约 650 kB，Vite 仍提示单 chunk 超过 500 kB；在 Electron/生产交付前需要做代码分块与体积预算。

## 下一个最小任务

进入 M0-C：先用 FakeProvider 建立冻结 Agent Session、Tool Gateway、提案/审批/执行状态机和绑定 action hash 的一次性能力票据，再接真实 API provider。必须复用 M0-B 的 RuntimeBinding 复核，不允许模型直接选择 target、binding 或填写 `approved: true`。

开始前应再次检查工作区与 Git 状态，不覆盖用户变更。
