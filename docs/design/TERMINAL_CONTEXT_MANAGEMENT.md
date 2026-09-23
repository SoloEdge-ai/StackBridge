# Terminal context management

This design implements the approved 2026-09-22 plan on `codex/terminal-context-management`, based on main `cacd426`. Deliver an unmerged PR and a local Windows portable executable for user testing.

## Conversation and attachments

One AI conversation continues across terminal panes; provider/model remain frozen. Each turn independently freezes its execution approval scope. Highlighting represents only the terminal attachment selected for the next message, not everything known through conversation history.

Auto considers only the current terminal's latest three command blocks and subtracts successfully delivered output ranges. Older commands are never backfilled. Running commands contribute only unsent output; their command text identifies the source. Manual selection attaches a command and its retained output together and permits explicit repeats. None means no new terminal data; existing conversation history remains.

Core's prepared context freezes the chosen bytes and source metadata, bounds the actual JSON context to 64 KiB, prioritizes latest content, and reports truncation/gaps. A prepared ID is browser-session-bound, terminal-bound, single-use and valid for ten minutes. Existing conversations bind at preparation; a draft binds once when creating its conversation using that prepared ID. Expired previews must be refreshed and explicitly sent again. Pending requests reject concurrent turns in the same conversation. Only successful turns advance delivery accounting; failure, cancellation and unknown outcomes do not.

Message snapshots persist the mode, outcome, exact context JSON and attachments (source, command, retained byte range, content and truncation flags). SQLite schema 4 versions this snapshot extension and backs up older databases before migration. Legacy messages have no inferred attachment history; pending snapshots loaded after a restart become unknown. Execution approvals remain scoped to the actual terminal at turn time and cannot be retargeted by an attachment.

ChatGPT uses its existing Codex thread and receives only this turn's prepared context. DeepSeek reconstructs successful complete user/assistant pairs with their attachments, keeping newest complete pairs within a separate 64 KiB history budget. History trimming never changes delivery accounting. The UI explains that prior history may be trimmed and explicit reattachment is available.

## Display and interaction

Terminal output frames carry ordered UTF-8 positions; command candidates carry command/output boundaries and replay starts carry the retained offset. The renderer records xterm markers only after ordered parsing. A separate pointer-transparent layer paints exact locatable ranges; it never replaces the normal copy selection. Manual selection and the list are synchronized. Top/bottom handles select adjacent whole command blocks and enter manual mode. Truncated blocks show separate command and retained-output ranges, never the omitted middle.

Normal-buffer markers follow scrollback and row reflow. Exact boundaries missing after truncation, clear, reload, or partial-line width changes are not guessed: the attachment list remains available with a notice. Alternate-screen applications do not support contextual highlighting. Arbitrary text-snippet attachments and full-screen screenshots are out of scope. Historical messages expose frozen attachments and temporary location viewing; exiting restores the draft selection.

Quick Ask follows the cursor until dragged by its title or resized at the bottom-right handle. User positioning stays inside the terminal pane with a nominal 320×120 minimum, reduced when the pane is smaller, and internal scrolling for excess content. Position/size live in sessionStorage per terminal pane, survive closing/reopening Quick Ask, and are removed when that pane closes. Follow cursor resets the override. Pointer actions never enter the PTY.

## Public boundary and acceptance

`POST /v1/terminal-sessions/:id/ai-context` adds `prepare: true` and optional `conversationId`, returning `preparedId`, expiry, actual attachments, byte count and bounded candidate previews. Create-conversation and create-turn requests accept `preparedContextId`. Requests without preparation retain legacy selection behavior. Prepared context errors return 409 and preserve the draft for an explicit retry.

Core HTTP tests cover success-ledger deduplication, frozen preview vs later output, incremental running output, browser ownership, expiry/reuse, persistence recovery, cancellation and historical DeepSeek attachment replay. Browser tests cover whole-block highlighter/list synchronization, range dragging, floating movement/resizing/reopening/reset, existing routing controls and terminal keyboard behavior. Run typecheck, targeted tests, full tests, browser regression, production build and portable packaging, then independent Standards and Spec reviews. Do not automatically merge the PR.
