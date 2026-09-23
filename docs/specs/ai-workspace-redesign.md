# AI workspace redesign

Approved direction: keep the full conversation in a stable, resizable AI panel;
Quick Ask handles short questions and a bounded reply preview. Both are views of
the same conversation, not independent agents. This follows the user discussion
and [competitor research](../research/TERMINAL_AI_COMPETITORS_2026-09.md).

## Prototype decision

On 2026-09-23 the user approved continuing from variant A, the right companion
panel. The original three-variant interactive prototype is archived on the
[throwaway prototype branch](https://github.com/SoloEdge-ai/StackBridge/tree/codex/ai-workspace-prototype/apps/web/prototype)
at `554a9da`. It is a primary design reference, not production code. Variant B
(bottom workspace), variant C (conversation-focused workspace), and all simulated
requests stay out of main. Rebuild A using the existing shared assistant controller
and Core contracts rather than promoting the prototype state machine.

## Scope and invariants

- One visible composer at a time. Open conversation / Read full answer moves from
  Quick Ask to the dock; Back to Quick Ask returns to the active terminal pane.
- Switching views preserves that pane's unsent draft, attachment selection,
  provider/model lock, conversation history and pending request. It neither creates
  a new conversation nor submits another turn.
- Conversation continuity across terminal panes remains. Each pane retains its own
  draft and per-message attachment choice; successful-delivery deduplication and
  Core's frozen execution/approval scope are unchanged.
- The dock has a draggable divider, keyboard width adjustment, a remembered width,
  and bounded placement on smaller windows. It is closed by default.
- Full replies use the existing safe Markdown renderer in one conversation scroll
  area. Quick Ask displays a bounded, non-scrolling reply preview and an explicit
  full-answer entry. Suggested commands are reviewed/approved in the full panel.
- Provider/model remain visible; connection/model settings are collapsed until
  requested. History and new-conversation actions stay accessible.
- Current-message attachments sit beside the composer: mode, provider destination,
  approximate size, terminal source and removable command chips. Detailed selection
  opens a separate modal, shared by both views, without nesting scroll areas in
  the small Quick Ask. Escape dismisses that modal only; IME input is not intercepted.
- Terminal highlights continue to mean only this message's terminal attachment,
  not full conversation history. Removing an automatic chip switches to an explicit
  manual selection of the remaining blocks.
- Improve readability (14px AI body, 12px primary metadata), spacing and controls;
  avoid changing terminal font settings or adding provider/API capabilities.

## Validation and delivery

### Acceptance follow-up: compactness and stale-command recovery

- Keep provider/model visible with one compact mode/count control. Show a short
  terminal source and size only when attaching terminal blocks. Put full paths,
  destination details and the zero-new-output explanation inside the context modal.
  Keep truncation/missing-content warnings visible. Retain 14px body / 12px metadata.
- Do not repeat the pending question below the Quick Ask input. Dragging preserves
  content-driven height; explicit resize may set a height. Restore compact removes
  the custom size while keeping fixed placement and the draft/attachment selection.
- Approval failures belong on the affected command card, not the chat-wide error
  banner. A stale/expired card offers Recheck for confirmation.
- `POST /v1/approvals/:id/recheck` accepts no command or target overrides. Core
  checks the original terminal, frame, binding, cwd, shell and user, write lease,
  verification, idle state and empty input. It never retargets to the focused pane.
- Recheck creates a new pending proposal and AgentSession with freshly frozen
  versions, linked to the immutable original. It does not call the model or write
  to the PTY. A separate explicit execute/insert decision is required and revalidates
  the frozen scope again. Already submitted/inserted/rejected proposals cannot renew.
- Persist the replacement chain atomically; repeated recheck of the original
  returns the same replacement, never extra executable copies. Restoring history
  after restart does not restore a missing terminal or execution authority.
- Keep strict context/input version checks; this change adds a recovery path, not
  a bypass. Show the replacement in its original message card, with a review notice.

Use the established browser UI seam for view handoff, attachment removal,
in-flight requests, width persistence/bounds, Markdown, Escape/F8, real PTY input
and pane switching. Add Core HTTP checks for recheck, identity/lease/readiness
guards, separate final approval, idempotency and persisted replacement chains; run full tests,
typecheck, build and Windows portable packaging. Review against the main baseline
`1e00950c6de7b2c922e52ab33829d0cc3099e5ed`.

Deliver a PR and a local preview EXE for acceptance, without automatic merge.
Do not close a user's existing app or terminal sessions without permission.
