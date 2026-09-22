# Quick Ask provider identity and per-message context

Quick Ask and the full AI panel show the frozen conversation provider/model (or the draft provider/model before a conversation starts), destination provider, attached-output count, and approximate serialized terminal-context size in KiB. Provider/model remain locked after conversation creation.

The context button expands an accessible command-block selector with three per-message modes:

- Auto: current terminal metadata, the latest 20 command summaries, and the latest 3 outputs.
- Manual: current terminal metadata and only selected command blocks, including their outputs. No other commands are automatically included.
- None: no new terminal metadata or command blocks are sent. Existing conversation history remains; changing this setting cannot retract data already sent in prior turns.

Selections belong to the terminal pane's draft, are shared by both composers, and can be changed between messages. Sending freezes the chosen mode/IDs. Explicit command-explanation actions use manual selection for that command. The local preview is refreshed when the selector opens, the terminal context changes, or a turn finishes. Size excludes question/history and provider framing; output truncation can reduce the transmitted size. Command previews show the last 4,000 characters.

HTTP `POST /v1/terminal-sessions/:id/ai-context` accepts optional `contextMode` and `commandIds`, returning approximate bytes, attached-output count, and the latest 20 command candidates. Turn requests accept the same fields. Omitted mode retains legacy automatic-plus-explicit-IDs behavior; explicit auto ignores stale manual IDs. None emits no terminal-context block to either provider. Execution approval scope is still frozen independently by Core.

Verification uses the Core HTTP boundary with a local Responses API and browser UI tests. Manual exclusion, mode changes, no-context omission, provider/model locking, and preview display are covered. Keep PR #3 open for user testing; do not merge.
