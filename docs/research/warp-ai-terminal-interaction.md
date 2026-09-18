# Warp AI / Agent 与终端输入的交互调研（2026）

> 调研日期：2026-09-18<br>
> 范围：Warp Terminal（用户所说的 “wrap” 按上下文理解为 Warp）当前桌面端交互，并回看旧版 `#` Generate 入口。<br>
> 来源策略：只采用 Warp 官方文档、官方 Changelog 和官方博客；事实与对 StackBridge 的建议分开陈述。

## 结论先行

Warp 当前的主方案已经不是“输入一个特殊字符，直接把 AI 结果塞进 Shell”。2026 年的产品结构是：

1. 平时保持一个干净的 Terminal mode，AI 控件默认隐藏。
2. 在终端输入行附近通过快捷键、`/agent`、自然语言自动识别或上下文建议进入 Agent conversation view。
3. 快速命令建议采用 ghost text：先接受到输入缓冲区，允许检查和修改，再按 Enter 执行。
4. 命令和输出按 Block 组织；可以明确附加最近 Block，也可以在 Agent 会话内自动继承该会话执行结果。
5. Agent 的“建议、批准、执行”是分开的；命令执行权限、allowlist、denylist 和临时 auto-approve 分层控制。

以上是 Warp 当前官方文档描述的 Terminal/Agent 双模式，而 `#` 生成命令已经被放进 **Generate (Legacy)** 文档。因此，StackBridge 应借鉴的是“输入行就近入口 + 内联结果 + 显式上下文 + 二段执行”，不应把旧 `#` 入口原样照搬成主交互。[Terminal and Agent modes](https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/) · [Generate (Legacy)](https://docs.warp.dev/agents/local-agents/generate/)

## 1. Warp 当前如何从终端输入行唤起 AI

### 1.1 Terminal mode 保持干净，Agent controls 按需出现

Warp 把普通终端和多轮 Agent 会话做成两个视觉上明确的模式：新 tab/pane 默认进入 Terminal mode；只有进入 Agent conversation view 后才显示模型选择、语音、图片附件和会话管理等控件。Terminal mode 底部仍有一行贴近输入框的状态/操作提示，而不是永久占用侧栏。[Terminal and Agent modes](https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/)

这条提示会随状态改变：空输入提示如何新建 Agent；输入疑似自然语言时提示发送给 Agent；上一条命令失败时提示附加该命令输出；已经附加 Block 时明确显示将携带什么上下文。也就是说，AI 的入口虽然轻量，但当前路由和即将发送的上下文并不是隐形的。[Terminal mode hints](https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/#terminal-mode-default)

### 1.2 显式入口：快捷键和 `/agent`

Warp 当前给出了两种主要的显式入口：

| 入口 | Windows / Linux | 行为 |
|---|---:|---|
| 快捷键 | `Ctrl+Shift+Enter` | 从 Terminal mode 立即进入 Agent conversation view；等价于 `/agent` |
| 输入命令 | `/agent` 或 `/new` | 打开一个新 Agent 会话及完整控件 |
| 输入并发送 | `/agent <prompt>` | 在新会话中直接发送 prompt |

官方把 `/agent` / `/new` 称为显式切换到 Agent Mode 的推荐方式；快捷键适合在发送前还要附图片、使用语音或检查上下文的人。[How to enter a conversation](https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/#how-to-enter-a-conversation)

### 1.3 自动识别自然语言，但有可见状态和人工覆盖

Warp 可在 Terminal mode 中识别当前输入更像自然语言还是 Shell 命令。判断为 Agent 请求时，输入行显示 `(autodetected)`；用户按 Enter 后才真正发送给 Agent。这个 quicksend 适合不需要额外附件的短问题。[Understanding auto-detection](https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/#understanding-auto-detection)

自动识别不是不可逆的黑盒：

- Windows/Linux 使用 `Ctrl+I` 在当前条目上强制切换 shell / agent；覆盖结果对该条输入保持稳定。
- 在 Agent view 中，以 `!` 开头会强制按 Shell 命令处理，例如 `!git status`。
- Terminal mode 与 Agent view 的自动识别可分别开关。
- 新用户默认开启；旧用户升级时默认关闭，以避免改变原有终端习惯。

这些行为均来自当前的 [Terminal and Agent modes](https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/#override-methods) 文档。

### 1.4 输入行内的控制字符

在当前 Agent conversation view 中，Warp 把少量字符用作“输入修饰符”：

| 字符 | 当前作用 |
|---|---|
| `!` | 强制把这一条当 Shell 命令 |
| `/` | 打开 Agent 动作菜单，如 `/new`、`/plan`、`/compact`、`/fork`、`/model` |
| `@` | 打开上下文菜单，附文件、符号、Block 等 |
| `?` | 显示/隐藏快捷键面板 |

这些修饰符是 Agent 输入编辑器的语义，而不是无条件劫持 PTY 字节；官方也允许为 slash command 绑定自定义快捷键。[Keyboard shortcuts and input modifiers](https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/#keyboard-shortcuts-quick-reference)

### 1.5 右键/命令块入口

Warp 将一条命令和它的输出组织成 Block。用户可以在 Block 上点击 AI sparkles，并选择 **Attach as context**；最典型的流程就是附加失败输出后问 “fix it”。Windows/Linux 也可用 `Ctrl+↑` 附加最近 Block，继续按方向键选择其他 Block，再用 `Ctrl+↓` 移除。[Blocks as Context](https://docs.warp.dev/agents/local-agents/agent-context/blocks-as-context/)

官方 Block actions 文档同时说明，Block 的通用操作可通过右键或三点菜单进入；当前 AI 上下文文档更明确推荐 sparkles → Attach as context。因此，对当前实现应以“Block 的显式上下文入口”为准，而不是只依赖一个全局聊天按钮。[Block Actions](https://docs.warp.dev/terminal/blocks/block-actions/) · [Blocks as Context](https://docs.warp.dev/agents/local-agents/agent-context/blocks-as-context/)

### 1.6 `#` 是旧路线，不是 2026 主入口

Warp 的旧 Generate 能力允许在命令行输入 `#` 或按 `Ctrl+``，然后用自然语言实时生成 Shell 命令；prompt 可以继续修改，满意后可运行或保存为 Workflow。但这一整页现在明确标记为 **Generate (Legacy)**，交互式程序中的旧 Generate 也已被 Full Terminal Use 替代。[Generate (Legacy)](https://docs.warp.dev/agents/local-agents/generate/)

Warp 2024 年发布 Agent Mode 时也曾表示，`#` AI Command Suggestions 只会短期保留，长期方向是由 Agent Mode 统一承接。[Agent Mode announcement](https://www.warp.dev/blog/agent-mode)

因此，“Warp 怎么做”需要区分年代：

- 2023/2024：`#` 是显眼、低学习成本的命令生成入口。
- 2026：Terminal/Agent 双模式、`/agent`、快捷键、自动识别、`@` 上下文成为主路径；`#` 进入 Legacy。

## 2. 建议如何原位展示、编辑、插入和执行

### 2.1 Next Command：接受到输入行，与执行分开

Warp 的 Next Command 基于当前终端会话生成下一条命令，并以内联/ghost suggestion 的方式显示。用户按 `→` 或 `Ctrl+F` 只是把建议接受到输入 buffer；之后仍需按 Enter 执行。接受快捷键还可改成 Tab。[Active AI Recommendations — Next Command](https://docs.warp.dev/agents/local-agents/active-ai/#next-command)

这个细节很重要：

- “看到建议”不改变 Shell。
- “接受建议”只改变本地输入缓冲区，用户可以继续编辑。
- “执行建议”才向 Shell 提交。

Warp 的 changelog 还记录过一次关键修正：Agent Mode 命令建议由“直接写入 buffer”改为 ghosted autosuggestion，说明产品主动把 AI 建议与用户已输入内容区分开。[Warp Changelog 2024-10](https://docs.warp.dev/changelog/2024)

### 2.2 Prompt Suggestion：原位 chip，但接受后进入 Agent

Prompt Suggestions 是贴近终端的上下文 banner/chip。Windows/Linux 可按 `Alt+Shift+Enter`，或直接点击 chip；接受后，建议会进入输入并在 Agent Mode 运行，同时自动附上最近 Block。Warp 明确说明这类提示是基于最近一个 Block 生成的。[Active AI Recommendations — Prompt Suggestions](https://docs.warp.dev/agents/local-agents/active-ai/#prompt-suggestions)

这与 Next Command 的语义不同：Prompt Suggestion 是“建议你问 Agent 什么”，Next Command 是“建议下一条可能要运行的 Shell 命令”。二者在 UI 上应明确区分。

### 2.3 Agent 请求的命令：先作为待批准动作，不伪装成用户输入

Warp Agent 在真实终端里运行命令并读取输出，但 Agent actions 受权限与批准控制。当前文档把 Execute commands 独立列为一种 permission，默认产品方向是让用户在动作发生前保持控制。[Agents overview](https://docs.warp.dev/agents/) · [Profiles & Permissions](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/)

官方 changelog 还记录了 requested command UX 重做、命令 refine、手动执行的 Agent suggested command 自动展开等迭代；这说明多轮 Agent 的命令建议是一个有状态动作卡/Block，而不只是把字符串偷偷塞进当前 PTY。[Warp Changelog 2025](https://docs.warp.dev/changelog/2025)

## 3. Warp 如何使用 command / output / context

### 3.1 Block 是上下文最小单元

Warp 的 Block 同时保存 command 与 output。Terminal view 中的 Block 可被附到多个 Agent 会话；Agent conversation 内执行的命令则只显示在该会话里，并自动成为之后 prompt 的上下文。[Blocks as Context](https://docs.warp.dev/agents/local-agents/agent-context/blocks-as-context/) · [Block origin and visibility](https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/#agent-conversation-view-expanded-ui)

在 Agent conversation 内，用户可以先运行 `npm test`，再直接问“为什么失败”，无需再次选择输出；如果命令是在普通 Terminal view 里运行，则需要明确附加对应 Block。[Automatic context in agent conversations](https://docs.warp.dev/agents/local-agents/agent-context/blocks-as-context/#automatic-context-in-agent-conversations)

### 3.2 上下文是可见、可选择、可移除的

Warp 区分 pending context 和 attached context：选择了 Block 但尚未发送时是 pending；发出首个 query 后才成为该会话的 attached context。发送前可以 Esc 或快捷键取消。[Pending and attached context](https://docs.warp.dev/agents/local-agents/agent-context/blocks-as-context/#pending-and-attached-context)

这比“默认把整个终端滚屏都发给模型”更可控，也能让用户知道“AI 到底看到了哪一条命令和哪段输出”。

### 3.3 主动建议会使用更宽的会话元数据

Warp Next Command 使用 command history，并补充 git branch、exit code、directory，以及最近 Block 的 input/output；Secret Redaction 会应用于发送给 Active AI 的内容。[Active AI Recommendations — context and privacy](https://docs.warp.dev/agents/local-agents/active-ai/)

### 3.4 SSH 中仍保持终端语义，但依赖自己的远端集成

Warp 官方说明，Warpified SSH 会话中，输入编辑器、补全、Block、历史和 Agent 命令执行可继续工作；更深的远端文件树、原生文件读取、code diff 等能力则依赖 Warp SSH extension。[Feature support over SSH](https://docs.warp.dev/code/ssh-feature-support)

这对 StackBridge 的启示不是照搬远端扩展，而是：AI 上下文必须绑定到已经核验的终端/环境层；同一条建议不可因为用户切到另一个 SSH 或 Docker 窗格就静默改目标。

## 4. Confirmation 与安全边界

### 4.1 权限按动作类型拆分

Warp 的 Agent Profiles 可分别控制 Apply code diffs、Read files、Create plans、Execute commands、Interact with running commands、Ask clarifying questions。权限等级包括 Agent decides、Always ask、Always allow、Never（并非每种动作都一定支持所有档位）。[Profiles & Permissions](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/)

对于 code diff，`Agent decides` 当前等同 `Always ask`，只有 `Always allow` 会跳过 review。也就是说，即使总体上允许较高自治，代码改动仍可以保留更严格的审阅边界。[Profiles & Permissions — autonomy levels](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/#agent-permissions)

### 4.2 allowlist 与 denylist

Warp 的 command allowlist 默认为空，可配置只读命令自动运行；默认 denylist 包括 `wget`、`curl`、`rm`、`eval` 等模式。denylist 优先于 allowlist 和 Agent decides，因此命中风险规则仍会要求批准。[Command allowlist and denylist](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/#command-allowlist)

### 4.3 临时全自动是显式模式，而不是默认行为

Warp 提供 Run until completion / auto-approve；Windows/Linux 快捷键是 `Ctrl+Shift+I`。开启后建议命令连续执行，直到任务结束或用户按 `Ctrl+C` 停止。官方明确把它描述为 “YOLO” 模式，并提醒它默认可绕过个人 denylist；团队强制 denylist 仍不可绕过。[Run until completion](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/#run-until-completion)

### 4.4 中止会话有防误触确认

当 Agent 仍在运行时，第一次 Esc/Ctrl+C 只显示“再按一次退出”之类的提示；用户需在约两秒内再次操作，才真正退出并取消任务。这避免把“返回终端”误当成“中止 Agent 工作”。[Exit confirmation for in-progress conversations](https://docs.warp.dev/agents/local-agents/interacting-with-agents/#exit-confirmation-for-in-progress-conversations)

## 5. StackBridge 值得借鉴的部分

### 5.1 推荐的入口层级

建议 StackBridge 采用三个并存但职责清楚的入口：

1. **主入口：可配置快捷键**

   保留当前 `Ctrl+Shift+Space`，但不再只打开远处的固定侧栏，而是在当前聚焦窗格的 prompt 上方打开“内联 AI composer”。原 Shell 输入内容保持不动，Esc 关闭并原样返回。

2. **键盘显式入口：`/ai` 或 `/agent`**

   只在 Shell 已核验为空闲、光标处于受管输入行且命令从首字符开始时识别；支持 `/ai <问题>` 直接发出。界面需先把它转换为 StackBridge 的本地控制动作，不把文本提交给 Bash/PowerShell。

3. **输出就近入口：CommandBlock 上的 Ask AI**

   每个结构化 command/output block 提供 `Explain`、`Fix`、`Ask AI…`；右键或块边缘按钮都可进入。点击时把该 Block 明确显示成 context chip。

推荐顺序的理由：快捷键无语法冲突；显式 `/ai` 对可发现性和自动化友好；Block 入口能准确解决“这个输出是什么意思”，不需要复制。

### 5.2 内联 composer 应长什么样

内联 composer 应锚定在当前 prompt 上方或紧贴其下方，而不是占满右侧：

```text
┌ AI · friden-dev-cube › docker:ubuntu22 · /workspace ───────────────┐
│ Ask about this terminal…                                           │
│ Context: [last command: npm test · exit 1] [Docker · verified]      │
│ Enter send · Shift+Enter newline · Esc close                        │
└──────────────────────────────────────────────────────────────────────┘
root@container:/workspace# _
```

发出后，短回答和单条命令留在终端中的 AI Block；需要多轮讨论、长解释或多张命令卡时，再扩展为当前窗格内的 conversation layer。历史会话可以有侧栏，但侧栏不应是首次提问的唯一入口。

### 5.3 建议命令必须分成三个状态

借鉴 Warp 的 ghost suggestion，但结合 StackBridge 已确定的强确认要求：

1. **Preview**：命令卡显示目的、完整命令、SSH/Docker 链路、用户和目录。
2. **Insert**：选择“放入输入行”只把命令写入受管输入 buffer，绝不按 Enter；用户可以编辑。
3. **Execute**：选择“确认执行”才创建不可重复的 operation，并在同一 Shell 可见运行。

原位 Next Command 可用低对比 ghost text 展示；接受 ghost text 和执行必须是两个动作。Agent 主动提出的多行/高风险命令不应直接变成 ghost text，而应使用可展开的审批卡。

### 5.4 上下文提示应该比回答更靠近输入行

在 composer 上方用短 chip 展示：

- 当前环境：`Local → SSH: L001 → Docker: ubuntu22`
- 当前目录与用户：`root · /workspace`
- 已附带记录：`npm test · exit 1 · 128 lines`
- 截断/脱敏状态：`truncated`、`2 secrets redacted`

用户应能在发送前移除任一 CommandBlock。普通 Terminal mode 下不要默认发送整个滚屏；Agent 会话内才自动继承该会话中由用户或 Agent 执行的后续 CommandBlock。

### 5.5 自然语言自动识别可以后做，且默认关闭

Warp 可以承担自动识别，是因为它有自己的输入编辑器、明确的 mode indicator 和即时 override。StackBridge 当前核心优势是真实 PTY 和跨 SSH/Docker 链路；若在没有稳定 managed input buffer 的情况下猜测自然语言，误把 Shell 命令发给 AI 或误把问题交给 Shell 的成本更高。

因此建议：

- 第一阶段不自动识别；快捷键和 `/ai` 足够覆盖明确意图。
- 后续若加入，必须在 Enter 前显示 `AI` / `SHELL` 标记，并提供单键覆盖。
- 密码提示、vim/top、REPL、未核验环境、Shell 非空闲时完全关闭自动识别。
- 分类应本地完成；只有用户明确提交后才能把内容送给模型。Warp 也把“本地检测、提交前不外发”作为其自动识别的安全属性。[Agent Mode announcement — privacy and natural language detection](https://www.warp.dev/blog/agent-mode)

## 6. StackBridge 不应照搬的部分

### 6.1 不要把 `#` 作为唯一或默认入口

`#` 在 Bash、Zsh 和 PowerShell 中本来就是注释起始符。无条件截获会破坏终端兼容性，漏截又会造成用户以为已提问、实际 Shell 静默忽略。更关键的是，Warp 自己已经把 `#` Generate 标为 Legacy。[Generate (Legacy)](https://docs.warp.dev/agents/local-agents/generate/)

如果产品仍希望提供 `#` 风格的实验入口，应满足：仅空闲 prompt、仅首字符、出现可见 AI mode 标记、可在设置中关闭、未命中时完整回退给 Shell；但它不应先于快捷键与 `/ai` 实现。

### 6.2 不要在原始 PTY 字节流中全局拦截特殊字符

`!`、`/`、`?`、`#` 在 Shell、REPL、密码输入、vim 和远端程序中都可能有真实含义。Warp 的这些字符属于自有 input editor / Agent view；StackBridge 若照搬到原始终端层，会破坏应用输入。

StackBridge 的字符入口必须建立在 Shell integration 已确认的状态上：prompt 可用、无前台程序、input version 可验证、当前行由受管编辑层持有。否则只允许使用应用级快捷键，不拦截字符。

### 6.3 不要默认开启自然语言检测

Warp 为自动检测配套了 `(autodetected)` 标记、手动覆盖和分别可配置的开关。[Understanding auto-detection](https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/#understanding-auto-detection) StackBridge 目前跨本地、SSH、嵌套 SSH 与 Docker；环境状态不确定时，误路由比少一次自动化更危险。

### 6.4 不要照搬可绕过 denylist 的 YOLO 模式

本轮 StackBridge 的已确认需求是“每次 AI 执行都需要确认”。因此即使参考 Warp 的 Profiles，也应保持：

- 默认及首版固定为 Always ask。
- 不提供全局 auto-approve 或“直到完成”。
- 解释输出、生成建议和插入输入行不等于批准执行。
- 每次批准绑定具体 terminal、environment frame、runtime binding、cwd、command digest 和 operationId。

Warp 的 Run until completion 是成熟产品里的可选高自治模式，而且官方明确提示其风险；不适合作为 StackBridge 首版捷径。[Run until completion](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/#run-until-completion)

### 6.5 不要把 Agent 命令混进普通终端历史而失去归属

Warp 明确区分 Terminal blocks 与具体 conversation 中的 Agent blocks。[Block visibility across views](https://docs.warp.dev/agents/local-agents/agent-context/blocks-as-context/#block-visibility-across-views) StackBridge 虽然可以在同一 PTY 中可见执行，但持久化数据仍应区分 `manual` 与 `ai-approved` source，并关联 proposal、approval、operation 和 frozen environment。

## 7. 建议给 StackBridge 的交互决策

### 推荐方案

| 场景 | 推荐交互 | 是否发送终端上下文 | 是否执行命令 |
|---|---|---:|---:|
| 快速问法 | `Ctrl+Shift+Space` 打开当前 prompt 的 inline composer | 默认附最近相关 Block，发送前可见/可移除 | 否 |
| 键盘显式提问 | `/ai 为什么失败？` | 默认附上一失败 Block | 否 |
| 针对历史输出 | CommandBlock 右键 → Explain / Fix / Ask AI | 只附所选 Block | 否 |
| AI 给出单条低风险命令 | 原位 ghost preview + `Insert` | 已绑定生成时环境 | Insert 后仍不执行 |
| AI 给出多行或高风险命令 | 展开命令卡 | 显示固定目标/cwd/user | 每条明确确认 |
| 多轮追问 | 当前窗格扩展 conversation layer | 自动继承该会话内的新 Block | 仍逐条确认 |
| 前台程序/密码提示 | 仅应用快捷键打开只读问答；不拦字符、不自动执行 | 截至触发时的屏幕快照，标记捕获质量 | 禁止自动提交 |

### 建议键位与文本协议

- `Ctrl+Shift+Space`：打开/收起 inline AI composer；不改变 Shell 输入。
- `Esc`：关闭 composer 并把焦点还给原终端；若 Agent 正在生成，第一次只聚焦停止提示，避免误取消。
- `/ai`：显式进入当前连续 conversation；`/ai <text>` 直接提问。
- `/new-ai`：显式新建 conversation，避免把无关问题继续塞进旧上下文。
- `Ctrl+↑`：在 composer 已打开时附加上一 CommandBlock；不得覆盖 Shell 自己的历史快捷键。
- `@`：仅在 composer 内打开 context picker；不在普通 PTY 中劫持。
- `!`：不建议在 StackBridge 首版复用，因为 composer 已与 Shell 输入视觉分离，不需要再反向强制 Shell。

## 8. 最小可验证原型

建议先实现一个很窄的交互闭环来验证“离输入最近”是否成立：

1. 在已核验、空闲的 prompt 按 `Ctrl+Shift+Space`。
2. prompt 上方出现 inline composer，当前 Shell 输入不变。
3. composer 显示当前 `Local → SSH → Docker` 和最近失败 CommandBlock chip。
4. 输入“这个错误什么意思”，Enter 发送。
5. 回答作为紧邻该命令输出的 AI Block 出现，而不是强制打开永久侧栏。
6. AI 命令建议显示 `Insert` / `Confirm & Run`；先点 Insert，可编辑但不执行。
7. 再显式确认，命令在同一 Shell 中可见运行；结果回到原建议卡。
8. 切换窗格或环境后，旧建议显示目标已变化，不能直接执行。

这条 tracer bullet 能一次验证入口距离、上下文归属、输入保护、确认边界和同 Shell 执行，不需要先实现自然语言自动检测或 `#` 截获。

## 9. 主要官方来源

- [Terminal and Agent modes](https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/)
- [Interacting with agents](https://docs.warp.dev/agents/local-agents/interacting-with-agents/)
- [Blocks as Context](https://docs.warp.dev/agents/local-agents/agent-context/blocks-as-context/)
- [Active AI Recommendations](https://docs.warp.dev/agents/local-agents/active-ai/)
- [Profiles & Permissions](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/)
- [Generate (Legacy)](https://docs.warp.dev/agents/local-agents/generate/)
- [Feature support over SSH](https://docs.warp.dev/code/ssh-feature-support)
- [Warp Changelog](https://docs.warp.dev/changelog)
- [Agent Mode announcement](https://www.warp.dev/blog/agent-mode)
