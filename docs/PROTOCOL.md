# M0-A Core 协议

更新日期：2026-09-17  
状态：M0-A 原型协议；后续版本需要显式版本协商。

## 传输边界

- Core 默认仅监听 `127.0.0.1:7331`。
- 开发 UI 由 Vite 在 `127.0.0.1:5173` 提供，并代理 `/v1` HTTP 与 WebSocket。
- Core 拒绝非 loopback `Host`；有副作用的 HTTP 请求和所有 WebSocket 升级必须带显式允许的 `Origin`。
- 每次 Core 启动生成随机启动令牌，也可用 `STACKBRIDGE_LAUNCH_TOKEN` 固定。令牌通过 `Authorization: Bearer` 只交换一次，不放入 URL 或 Web Storage。
- 认证成功后使用 `HttpOnly; SameSite=Strict; Path=/` cookie。开发环境为本地 HTTP，因此未设置 `Secure`。

## HTTP

### `POST /v1/auth/session`

请求头：

```text
Authorization: Bearer <launch-token>
Origin: <allowed-origin>
```

成功返回 `204` 并设置本地会话 cookie。令牌或来源不合法时返回 `401` 或 `403`。
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
