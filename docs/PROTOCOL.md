# M0-A Core 协议

更新日期：2026-09-18
状态：M0-A 本地终端与 M0-B2 远端会话原型协议。

## 传输边界

- Core 默认仅监听 `127.0.0.1:7331`。
- 开发 UI 由 Vite 在 `127.0.0.1:5173` 提供，并代理 `/v1` HTTP 与 WebSocket。
- Core 拒绝非 loopback `Host`；有副作用的 HTTP 请求和所有 WebSocket 升级必须带显式允许的 `Origin`。
- UI 通过同源 `POST /v1/auth/session` 自动建立本机浏览器会话，不要求用户输入令牌。该请求仍受 loopback `Host` 与允许的 `Origin` 双重校验，其他站点不能创建会话。
- 认证成功后使用 `HttpOnly; SameSite=Strict; Path=/` cookie。开发环境为本地 HTTP，因此未设置 `Secure`。

## HTTP

### `POST /v1/auth/session`

无需请求体。成功返回 `204` 并设置本地会话 cookie；来源不合法时返回 `403`。
Core 侧认证会话最长保留 8 小时且最多保留 32 个；达到上限时淘汰最早的记录。

### `GET /v1/auth/status`

有效 cookie 返回：

```json
{ "authenticated": true }
```

### `POST /v1/terminal-sessions`

请求：

```json
{ "cols": 120, "rows": 32 }
```

响应：

```json
{
  "id": "b0dc5ee4-b313-4af8-9acd-01ef138e51d7",
  "state": "running",
  "cols": 120,
  "rows": 32,
  "replay": ""
}
```

Core 创建一次真实 PTY 并持有它。网页关闭或刷新不会调用 PTY kill。
Core 最多同时持有 16 个终端会话；达到上限时先淘汰已退出会话，没有可淘汰项则返回 `503`。

### `DELETE /v1/terminal-sessions/:id`

显式关闭终端标签对应的 PTY，断开其 WebSocket，并释放本地会话容量。SSH/Docker 终端还会关闭关联的 runtime 管理连接。普通页面刷新不会调用此接口，因此仍可重新附着原终端。

## WebSocket

路径：`/v1/terminal-sessions/:id/stream`

升级请求必须携带有效 cookie 和允许的 `Origin`。成功附着后，Core 首先发送：

```json
{
  "type": "ready",
  "sessionId": "b0dc5ee4-b313-4af8-9acd-01ef138e51d7",
  "state": "running",
  "cols": 120,
  "rows": 32,
  "replay": "...",
  "writable": true
}
```

客户端消息：

```json
{ "type": "input", "data": "pwd\r" }
```

```json
{ "type": "resize", "cols": 132, "rows": 40 }
```

```json
{ "type": "acquireWriteLease" }
```

服务端实时事件：

```json
{ "type": "output", "data": "..." }
```

```json
{ "type": "writable", "writable": false }
```

```json
{ "type": "exit", "exitCode": 0, "signal": 0 }
```

```json
{ "type": "error", "code": "invalid_message", "message": "..." }
```

所有入站消息都经过共享 Zod schema 校验；二进制控制消息、非法 JSON、未知类型和越界尺寸被拒绝。

## 重连与限制

- session ID 不是授权凭证；每次 HTTP/WS 操作仍需认证 cookie。
- Core 为每个终端保留最后 1 MiB UTF-8 安全回放。重新附着先收到 `ready.replay`，随后接收实时事件。
- 会话和回放仅在内存中。Core 重启后旧 session ID 失效，UI 会要求创建新终端。
- 同一终端只有一个 WebSocket 持有写入租约。首个连接默认可写，后续连接只读；只读客户端可发送 `acquireWriteLease` 显式接管，原写者随即收到 `writable: false`。写者断开后租约自动转交给最近连接。
- Core 为每个 WebSocket 设置 2 MiB 待发送上限，Web 渲染队列设置 4 MiB 上限；慢客户端超过上限时以 `1013` 断开，避免无界内存增长。
- 终端数据仍是不可信字节流，只交给 xterm.js 渲染，不解析为权限、目标身份或控制指令。

## 远端会话 HTTP

所有端点继续要求有效的本地认证 cookie 和允许的 `Origin`。

### `POST /v1/remote-sessions`

请求包含 SSH 主机、端口、用户以及可选 Docker 目标。首次请求只探测并比较版本；如需写入，返回 `409 deployment_approval_required`、部署提案和短时有效的一次性 `approvalId`。UI 冻结连接字段并展示提案，确认后以完全相同的参数和 `deploymentApprovalId` 重试。Core 同时复核目标参数以及提案中的主机指纹、版本、架构和摘要；任一变化都会废弃旧授权并要求重新确认。

成功返回内存会话 ID、目标类型、核验过的主机指纹、runtime 版本/摘要、架构、cwd、shell 与部署结果。密码、私钥、口令和令牌不属于该请求。Core 最多保留 16 个远端会话，达到上限时返回 `503 remote_session_limit_reached`，避免无界创建 SSH runtime 进程。

### `POST /v1/remote-sessions/:id/manual-execute`

请求为严格的结构化 argv：

```json
{
  "cwd": "/workspace",
  "program": "/usr/bin/uname",
  "args": ["-a"],
  "timeoutMs": 15000
}
```

Core 从服务端会话取得 SSH 或 Docker 绑定；浏览器不能在执行请求中更换主机、容器、daemon 或 UID。响应包含退出码、stdout、stderr、超时与截断标记。该端点只服务于已认证本地用户在 UI 中填写并点击“运行”的手动操作，不暴露给模型或 Tool Gateway；M0-C 的模型工具执行必须另行经过 `ExecutionRequest`、action hash、审批和一次性能力票据。

### `DELETE /v1/remote-sessions/:id`

关闭 SSH runtime 连接并删除内存会话。Core 退出时也会关闭全部远端会话。

## Go runtime protocol 2

M0-B2 将 SSH stdio 协议从 1 升至 2。握手增加 `runtimeVersion` 与当前可执行文件的 `runtimeDigest`；Core 只接受与本地已批准产物清单完全一致的身份。旧协议 runtime 被视为需要升级，不会作为就绪会话使用。

固定 CLI 模式为 `version`、`install`、`rollback`、`stdio`、`container-probe` 和 `container-exec`。部署参数通过有界严格 JSON stdin 传入；远端命令只包含固定程序路径、固定模式和应用生成的安全部署 ID。
