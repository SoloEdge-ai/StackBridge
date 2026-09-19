# StackBridge terminal-native AI interaction

Status: shortcut-only interaction implemented; terminal character triggers are intentionally excluded

## Outcome

The AI assistant should feel like part of the focused terminal pane, not a separate destination. The primary interaction is a compact Quick Ask popover anchored beside the active xterm cursor. It overlays rather than resizes the terminal and flips above the cursor when there is not enough room below. The existing side panel remains available for conversation history, model selection, context inspection, and long answers, but is no longer the default place to begin a question.

StackBridge should adopt Warp's proximity and explicit input modes without copying its natural-language auto-detection. Warp owns a native input editor and can decide whether the buffer is a command or a prompt before anything reaches the shell. StackBridge currently forwards xterm input to the real PowerShell/Bash/Zsh line editor, so silently classifying or withholding terminal bytes would weaken normal terminal behavior.

External product evidence is recorded in [`../research/warp-ai-terminal-interaction.md`](../research/warp-ai-terminal-interaction.md).

## Proposed interaction

### Primary entry: configurable shortcut

Use `F8` as the default. Pressing it:

1. Opens a one-line Quick Ask popover beside the xterm cursor in the focused terminal pane without changing terminal dimensions.
2. Focuses a one-to-three-line prompt editor without changing or clearing the shell's current input buffer.
3. Shows only a verified/unverified context dot while idle. Hovering or focusing reveals the full environment chain, cwd, shell, and attached-output count; activating it opens detailed context in the side panel.
4. Pressing it again, or pressing `Esc`, closes Quick Ask and restores focus to the same terminal pane.

`Enter` sends, `Shift+Enter` inserts a newline, and `Esc` returns to the terminal. IME composition must never trigger a shortcut or submit.

There is no secondary terminal-character entry. Do not reserve `#`, `?`, `!`, `/`, or `@`:

- each has existing meaning in at least one supported shell;
- StackBridge does not own the shell's line editor;
- intercepting raw xterm bytes is unsafe around paste, IME, SSH, full-screen programs, and custom key bindings;
- Warp's historical `#` entry point is not a good reason to break normal comments in PowerShell/Bash/Zsh.

This is a product boundary, not a follow-up item: terminal characters always go to the real shell.

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
    | F8
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

Context freezes when the user sends the prompt, not when Quick Ask opens. The compact composer represents the following attached context through its status dot and tooltip:

- current `Local -> SSH -> Docker` chain;
- cwd and shell;
- most recent command and output;
- current running-command snapshot, if one exists.

The side panel remains the inspectable detail and full-answer surface. Inline answers are capped to a 520px-wide, 150px-high preview. A user-selected command block or output range takes precedence over the automatic latest-command attachment. Switching panes after send does not retarget the turn or its proposals.

## Safety and compatibility

- Opening Quick Ask is allowed while a command or TUI is running, but command insertion/execution remains disabled until the verified shell is idle.
- Password prompts and alternate-screen programs are never treated as empty shell prompts.
- The terminal's existing input buffer remains in the shell. Opening or closing Quick Ask must not send backspace, clear-line, or synthetic submit bytes.
- Every AI command still requires explicit approval; this proposal does not add auto-execute.
- An unverified environment may receive explanations and copyable suggestions, but not managed insertion or execution.
- Terminal output is untrusted context and cannot request execution or approval.

## Implementation shape

The existing Core conversation and approval APIs are sufficient for the first iteration. Most work is Web-side:

1. Keep conversation state and `send`/`decide` operations in the dedicated assistant controller.
2. Keep one Quick Ask presentation per terminal pane, rendered as a DOM sibling over xterm rather than inside the PTY stream.
   Its anchor observes xterm screen mutations as well as pane resizing, so background output and cursor movement reposition the popover without requiring another shortcut press.
3. Route the configurable shortcut through Electron's focused-window input handler and a sandboxed preload bridge, with a browser keydown fallback for web development.
4. Reuse `ProposalCard` in the inline result and the side-panel history view.
5. Default the side panel to closed and expose `Open history` from Quick Ask.

No custom terminal input editor or natural-language classifier is required for this iteration.

## Acceptance cases

- The shortcut opens a focused prompt within the active terminal pane in one action.
- Existing partially typed shell input is byte-for-byte unchanged after opening and closing Quick Ask.
- The prompt grows from one to three lines; when the xterm cursor is near the bottom edge, the complete popover flips above it and remains within 20px of the cursor without resizing the terminal.
- The question is sent with the correct SSH/Docker chain and latest command output without copying.
- A proposal can be inserted or approved from the inline card and targets the frozen pane exactly once.
- Switching split panes changes the draft and next-turn target without retargeting an existing answer.
- `Esc`, IME composition, paste, `Ctrl+C`, password prompts, and alternate-screen programs retain their terminal behavior.
- The side panel is optional for the main ask-answer-run path.
