# 项目状态

更新日期：2026-09-17

| 范围 | 代码状态 | 验证状态 | 说明 |
|---|---|---|---|
| 仓库初始化 | implemented | verified | 本地 Git 仓库与私有 GitHub 仓库已建立 |
| 设计资料 | implemented | verified | 原始规格和交接材料已保留 |
| 设计评估 | implemented | verified | 已记录优势、风险、缺口和推荐顺序 |
| M0-A Windows Web 终端 | implemented | verified | 独立 Core、真实 PowerShell/ConPTY、鉴权 HTTP/WS、单写者租约、有界缓冲、输入、UTF-8、resize、Ctrl+C、刷新重连已通过自动化与浏览器冒烟测试 |
| M0-B0 目标协议 | implemented | verified | 四个权威 Zod schema、严格边界、版本字段和语言无关 JSON fixture 已通过 TypeScript 契约测试 |
| M0-B1 SSH/Docker 目标执行 | implemented | verified | Core 经严格 OpenSSH 启动固定路径 Go runtime；真实 Ubuntu 22.04 amd64 宿主与容器已验证握手、指纹、结构化 argv、同名文件防串线、Docker 身份复核和容器重建后旧 binding 拒绝 |
| M0-C API Agent | not-started | not-started | 未读取或配置任何模型凭证 |
| M0-D Codex 集成 | not-started | not-started | 尚未锁定和验证 App Server 版本 |
| M1–M4 | not-started | not-started | 等待 M0 风险验证 |

## M0-A 尚未覆盖

- 中文输入法组合态、vim/top 等全屏程序和持续高吞吐压力。
- Core 重启后的会话恢复、SQLite 持久化和日志分块。
- 生产同源 UI、Electron 外壳和 Windows 安装包。

“verified” 仅适用于表中说明的原型范围，不代表 M1 的完整终端能力或正式产品已经完成。

M0-B1 的环境、证据、复现方式与未覆盖边界见 [SSH/Docker 验证记录](M0-B1-VERIFICATION.md)。
