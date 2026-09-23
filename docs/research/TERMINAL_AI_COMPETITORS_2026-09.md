# 终端 AI 交互与 UI 竞品调研

调研日期：2026-09-23。范围：Warp、Wave Terminal、VS Code/Copilot、Windows Terminal；依据官方文档与官方文档源码，未安装四款产品逐项实测。以下明确区分产品事实、本地代码观察与设计建议；不比较价格，不把路线图视为已发布能力。

## 结论

当前最需要调整的是交互层级与阅读空间，而不只是换配色。竞品并非都采用侧栏，但 Warp 与 VS Code 都明确区分快速入口和完整会话；Wave 则提供 AI 面板及显式的上下文访问开关。StackBridge 可以保留已有上下文与安全机制，重新组织其展示方式。

## 官方事实对照

| 产品 | 交互与上下文 | UI、导航与可借鉴点 |
|---|---|---|
| Warp | Terminal mode 默认简洁；多轮任务进入独立 Agent conversation view，模型、附件及会话管理随之展开。命令与输出构成 Block，可显式附加；会话内执行结果自动供后续问题使用，待发送与已附加上下文有区别。 | 两种模式以背景及输入工具栏区分；终端提示条显示入口与附件状态，`?` 可查看会话快捷键。值得借鉴职责分离及命令块就近入口，不等于照搬其模式切换。[模式](https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/) · [Block 上下文](https://docs.warp.dev/agents/local-agents/agent-context/blocks-as-context/) |
| Wave Terminal | AI 面板有键盘入口。Widget Context 开启时允许访问终端输出、widget 与经批准的文件；关闭后仅使用聊天消息和显式附件。文档把部分远端访问及命令执行能力列为 Coming Soon，本报告不算作已实现。 | 将终端、预览与 AI 作为工作台能力；终端标题菜单可改主题、字号，tab 背景与终端配色分开配置。值得借鉴可见的上下文权限及分层定制，不推断其具备 StackBridge 的逐命令增量去重。[AI 官方源码](https://github.com/wavetermdev/waveterm/blob/main/docs/docs/waveai.mdx) · [定制](https://docs.waveterm.dev/customization) |
| VS Code / Copilot | Terminal inline chat 提供 Run 与 Insert 两个不同动作；后者先放入终端供修改。Quick Chat 面向短问题，可通过 Open in Chat view 延续到完整聊天；`#` 或 Add Context 可显式选择终端输出等来源。 | 轻量入口不承担所有长对话工作。最值得借鉴的是“短问 → 完整会话”的清晰升级路径，以及发送前的附件选择。[Inline / Quick Chat](https://code.visualstudio.com/docs/chat/inline-chat) · [上下文](https://code.visualstudio.com/docs/chat/copilot-chat-context) |
| Windows Terminal | 本报告仅用作非 AI 基线：同 tab 多窗格、焦点切换、窗格缩放和放大；不据此宣称其不存在其他 AI 实验功能。 | 聚焦窗格有强调色边框；可搜索命令面板让操作与快捷键可发现；应用主题与终端内容配色分别管理。值得借鉴明确焦点和稳定布局。[窗格](https://learn.microsoft.com/en-us/windows/terminal/panes) · [命令面板](https://learn.microsoft.com/en-us/windows/terminal/command-palette) · [主题](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/themes) |

这组来源没有证明竞品采用“相邻两次请求绝不重复发送输出”的同一算法，也没有给出统一聊天字号或窗口尺寸。不能把 StackBridge 的设计选择包装成行业标准。

## StackBridge 本地观察

检查基线为合并后的 `1e00950`，主要证据见 [styles.css](../../apps/web/src/styles.css)。这些是代码事实，不是竞品测量：

- Quick Ask 正文字号为 11px，回答区域最高仅 `min(150px, 22vh)`；长解释天然需要频繁滚动。
- `.inline-assistant strong` 固定 10px，Markdown 粗体可能比正文更小；其他辅助标签有 7–9px，层级依赖细小、低对比文字。
- 浮窗内部同时包含回答、上下文列表与输出预览等滚动区域；浮窗基础间距和内边距仅 3px，又叠加多层边框。

**判断：** Quick Ask 正承担完整聊天、上下文管理及浮窗布局三类任务，信息密度超过其可用面积。“不舒服”和“不好看”有结构性原因；只加 Markdown、拖拽和更多按钮无法解决。

## 下一轮建议（尚未批准实施）

1. **先确立主场所。** 默认终端优先，完整 AI 会话采用位置稳定、可调宽的停靠面板；Quick Ask 保留为短问题入口与短答预览，长答提供明确的“在 AI 面板继续”。这是结合竞品的建议，不是它们一致采用的布局。
2. **上下文紧邻输入，详情按需展开。** 用可移除的命令来源 chip 显示本次附件、增量/手动状态和大小；点击打开独立详情。终端高亮保留为辅助定位，不以高亮代表全部历史。
3. **减少常驻控制。** Provider/模型保留在紧凑标题行；配置、历史与高级选项移到各自入口。新请求默认来源与命令审批的冻结执行目标必须分别标明，跨窗格会话连续性不变。
4. **先做可读性规范。** 可从正文 14px、元信息 12px 的原型开始验证，统一间距、字号、按钮和强调色，减少套框及嵌套滚动；数值是待测试方案，不是竞品实测。中文、长代码、缩放与小屏必须一起看。
5. **先验交互，再扩功能。** 用“解释失败命令、连续追问、跨 SSH 窗格、审查建议命令”四个真实任务比较原型，记录查找入口、确认附件、读完回答与返回终端的操作成本，再决定是否实施。

既有 [ADR-0002](../adr/0002-continuous-conversation-frozen-execution.md) 的连续 ConversationSession 与冻结 AgentSession/CommandProposal 不应因 UI 重排而改变。旧 [Warp 调研](warp-ai-terminal-interaction.md) 的内联建议属于历史方案；本次依据当前使用反馈重新评估，不自动恢复字符拦截或未经批准的执行路径。
