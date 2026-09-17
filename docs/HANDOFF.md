# 当前交接

更新日期：2026-09-17

## 已完成

- 建立 StackBridge 本地 Git 仓库。
- 将原始规格与交接材料保存在 `docs/design/`。
- 增加项目首页、设计评估和诚实的状态矩阵。
- 建立 `SoloEdge-ai/StackBridge` 私有远端并推送 `main` 分支。

## 当前边界

仓库仍处于设计基线阶段。没有终端、Core、Electron、Go runtime、SSH/Docker 执行器或 AI provider 实现，也没有任何真实账号、远端主机或容器验证。

## 下一个最小任务

实现 M0-A 的最小垂直切片：

1. 建立 pnpm workspace、React/Vite Web 与独立 Node.js Core。
2. Core 在 Windows 上创建真实 PowerShell PTY，并通过带认证边界的 WebSocket 传输字节流。
3. Web 页面支持输入、输出、resize、Ctrl+C 和按 session ID 重连。
4. 增加单元与集成测试，证明刷新后附着同一会话、连续命令共享 Shell 状态。
5. 记录实际启动命令、依赖版本、测试结果和未验证项。

开始前应再次检查工作区与 Git 状态，不覆盖用户变更。

