# 当前交接

更新日期：2026-09-17

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

## 当前边界

M0-A 最小垂直切片可用，但仍是开发原型。没有 Electron、Go runtime、SSH/Docker 执行器、持久化层、AI provider 或 Codex 集成，也没有远端主机、容器、ARM64 或正式安装包验证。

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

已验证环境：Windows NT `10.0.26200.0`、Node.js `22.14.0`、pnpm `10.33.0`、node-pty `1.1.0`、PowerShell/ConPTY。

## 已执行的验证

- 共享协议 schema：合法输入/resize/写入租约/ready/output 与非法边界。
- 会话生命周期：断开订阅后 PTY 保持、回放有界、UTF-8 边界安全、退出后拒绝写入、终端数量上限。
- Core HTTP/WS：Origin、启动令牌、HttpOnly cookie、创建终端、输入/resize、单写者接管、刷新重连回放；错误 Origin 和缺失 cookie 的 WebSocket 升级会被拒绝。
- 浏览器认证会话：8 小时服务端过期、最多 32 个会话并淘汰最早记录。
- 真实 Windows PTY：同一 Shell 环境变量保持、UTF-8 中文与 emoji、真实 resize、Ctrl+C 中断长任务。
- 真实浏览器：认证、创建终端、刷新前后保持同一 session ID；Core 重启后的旧 session 会转为可恢复状态并可一键新建终端；浏览器控制台无错误。

尚未验证中文输入法组合态、vim/top 等全屏 TUI、持续高吞吐压力和打包后的干净 Windows 环境；这些不属于当前“verified”声明。
当前 Web 生产包约 648 kB，Vite 仍提示单 chunk 超过 500 kB；在 Electron/生产交付前需要做代码分块与体积预算。

## 下一个最小任务

进入 M0-B 前先安装 Go，并准备隔离的 SSH Linux 与 Docker fixture。随后建立 `ConnectionProfile`、`ExecutionTarget`、`RuntimeBinding` 与 `ExecutionRequest` 的权威 schema，以及 TS/Go 契约测试；不要直接连接生产主机。

开始前应再次检查工作区与 Git 状态，不覆盖用户变更。
