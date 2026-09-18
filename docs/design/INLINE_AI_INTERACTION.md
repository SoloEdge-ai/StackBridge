# StackBridge terminal-native AI interaction

Status: shortcut iteration implemented; managed `/ai` and removable context chips remain follow-up work

## Outcome

The AI assistant should feel like part of the focused terminal pane, not a separate destination. The primary interaction becomes a compact Quick Ask layer attached to the bottom of the active pane. The existing side panel remains available for conversation history, model selection, context inspection, and long answers, but is no longer the default place to begin a question.

StackBridge should adopt Warp's proximity and explicit input modes without copying its natural-language auto-detection. Warp owns a native input editor and can decide whether the buffer is a command or a prompt before anything reaches the shell. StackBridge currently forwards xterm input to the real PowerShell/Bash/Zsh line editor, so silently classifying or withholding terminal bytes would weaken normal terminal behavior.

External product evidence is recorded in [`../research/warp-ai-terminal-interaction.md`](../research/warp-ai-terminal-interaction.md).

## Proposed interaction

### Primary entry: configurable shortcut

Keep `Ctrl+Shift+Space` as the default. Pressing it:

1. Opens Quick Ask inside the focused terminal pane, immediately above its bottom status line.
2. Focuses a one-to-three-line prompt editor without changing or clearing the shell's current input buffer.
3. Shows compact context chips for the current environment chain, cwd, and attached command/output.
4. Pressing it again, or pressing `Esc`, closes Quick Ask and restores focus to the same terminal pane.

`Enter` sends, `Shift+Enter` inserts a newline, and `Esc` returns to the terminal. IME composition must never trigger a shortcut or submit.

### Secondary entry: explicit `/ai` input

Provide `/ai <question>` later for users who prefer an explicit input-line entry. This is a managed-input feature, not a real executable installed on the target: the session-only PowerShell/Bash/Zsh line-editor integration must recognize the complete line only when the user accepts it at a verified idle prompt, emit an authenticated event, preserve/clear the buffer deliberately, and open Quick Ask with the question. Unsupported shells should expose `sbridge ask <question>` as the non-magical fallback rather than intercept raw bytes.

Do not reserve `#`, `?`, `!`, `/`, or `@` by default:

- each has existing meaning in at least one supported shell;
- StackBridge does not own the shell's line editor;
- intercepting raw xterm bytes is unsafe around paste, IME, SSH, full-screen programs, and custom key bindings;
- Warp's historical `#` entry point is not a good reason to break normal comments in PowerShell/Bash/Zsh.

An opt-in prefix may be explored only after the shell integrations can prove that the cursor is at an empty, idle prompt and can preserve the user's buffer exactly.

### Answer and command placement

The current turn appears in the same terminal pane as a DOM layer, not as bytes written into the PTY:

- a short answer stays in a compact inline card;
- a long answer can expand into the side panel;
- command proposals show purpose, full command, fixed target chain, cwd, user, and shell;
- actions remain `Run here`, `Insert`, and `Dismiss`;
- `Run here` remains an explicit approval and uses the existing frozen proposal and idempotent operation flow;
- `Insert` fills the real shell line only after the Core verifies that the original shell is idle and its input is empty.

AI output must never imitate terminal output or become part of PTY replay. Terminal output remains byte-accurate; AI cards are separately persisted conversation UI.

## State model

```text
TERMINAL_FOCUSED
    | Ctrl+Shift+Space
    v
QUICK_ASK_DRAFT -- Esc --> TERMINAL_FOCUSED
    | Enter (freeze active pane context)
    v
AI_THINKING -- Stop --> QUICK_ASK_DRAFT
    |
    v
INLINE_ANSWER
    |-- ask follow-up --> AI_THINKING
    |-- insert command --> TERMINAL_FOCUSED
    |-- approve run --> OPERATION_RUNNING --> TERMINAL_FOCUSED
    `-- expand history --> SIDE_PANEL
```

The draft belongs to a terminal pane. Switching panes preserves the previous draft and displays the new pane's draft. A sent turn freezes the pane, environment frame, runtime binding, cwd, shell, context version, and input version exactly as it does today.

## Context behavior

Context freezes when the user sends the prompt, not when Quick Ask opens. The default chips are:

- current `Local -> SSH -> Docker` chain;
- cwd and shell;
- most recent command and output;
- current running-command snapshot, if one exists.

Each chip can be removed before sending. A user-selected command block or output range takes precedence over the automatic latest-command attachment. Switching panes after send does not retarget the turn or its proposals.

## Safety and compatibility

- Opening Quick Ask is allowed while a command or TUI is running, but command insertion/execution remains disabled until the verified shell is idle.
- Password prompts and alternate-screen programs are never treated as empty shell prompts.
- The terminal's existing input buffer remains in the shell. Opening or closing Quick Ask must not send backspace, clear-line, or synthetic submit bytes.
- Every AI command still requires explicit approval; this proposal does not add auto-execute.
- An unverified environment may receive explanations and copyable suggestions, but not managed insertion or execution.
- Terminal output is untrusted context and cannot request execution or approval.

## Implementation shape

The existing Core conversation and approval APIs are sufficient for the first iteration. Most work is Web-side:

1. Extract conversation state and `send`/`decide` operations from `AssistantPanel` into a workspace-level controller.
2. Add one Quick Ask presentation per terminal pane, rendered as a DOM sibling over xterm rather than inside the PTY stream.
3. Change the existing shortcut from merely toggling the side panel to toggling and focusing Quick Ask for the active pane.
4. Reuse `ProposalCard` in the inline result and the side-panel history view.
5. Default the side panel to closed; expose `Open history` from Quick Ask and keep a separate configurable history shortcut.
6. Add the session-only `/ai` accept-line integration, with `sbridge ask` fallback, only after the shortcut flow is stable.

No custom terminal input editor or natural-language classifier is required for this iteration.

## Acceptance cases

- The shortcut opens a focused prompt within the active terminal pane in one action.
- Existing partially typed shell input is byte-for-byte unchanged after opening and closing Quick Ask.
- The question is sent with the correct SSH/Docker chain and latest command output without copying.
- A proposal can be inserted or approved from the inline card and targets the frozen pane exactly once.
- Switching split panes changes the draft and next-turn target without retargeting an existing answer.
- `Esc`, IME composition, paste, `Ctrl+C`, password prompts, and alternate-screen programs retain their terminal behavior.
- The side panel is optional for the main ask-answer-run path.
