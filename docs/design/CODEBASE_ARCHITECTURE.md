# StackBridge codebase architecture

The product is organized around three stable boundaries. UI composition may change without changing terminal or approval semantics; Core routes may move without changing the local HTTP contract.

## Desktop shell

- `apps/desktop/src/main.ts` owns the Electron window, Core lifecycle, focused-window shortcut registration, and portable-process checks.
- `apps/desktop/src/preload.ts` is the only renderer bridge. It is built as CommonJS (`preload.cjs`) because the BrowserWindow is sandboxed.
- Real Windows shortcut coverage lives in `apps/web/e2e/desktop-shell.spec.ts`; DOM-dispatched events are not accepted as desktop shortcut verification.

## Web workbench

- `App.tsx` is the composition root and workspace coordinator; terminal rendering and menu details stay outside it.
- `workspace/terminal-layout.ts` owns immutable split-tree operations; `terminal-tabs-store.ts` owns persistence and legacy migration.
- `workspace/TerminalLayoutView.tsx` recursively renders split panes; `TerminalContextMenu.tsx` owns pane-local AI and split actions.
- `terminal/TerminalPane.tsx` owns one xterm/WebSocket attachment. It validates terminal context with the shared protocol schema and blocks the configured Quick Ask shortcut from entering the PTY byte stream.
- `desktop/quick-ask-shortcut.ts` owns desktop bridge registration, browser fallback, and IME coordination.
- `assistant/use-assistant-controller.ts` owns conversations, drafts, turns, approvals, and cancellation. Full history lives in `assistant/AssistantPanel.tsx`; cursor-anchored interaction lives in `assistant/InlineAssistant.tsx`.
- `workspace/WorkspaceDialogs.tsx` owns connection and settings forms. API error normalization lives in `api/client.ts`.

## Core

- `server.ts` composes the HTTP server, authentication boundary, static workbench, terminal creation, remote session compatibility routes, and shutdown.
- `workspace-routes.ts` owns terminal context/history, conversations, approvals, operations, and AI account routes.
- `browser-auth.ts` owns browser-session cookie decoding; `http.ts` owns bounded JSON input and JSON responses.
- Terminal, runtime binding, conversation, and approval services remain independent of HTTP routing.

## Product invariants

- Terminal bytes and AI UI are separate data paths.
- `F8` is the default AI shortcut; configured shortcut events must never reach xterm or the Shell.
- No terminal character sequence is reserved as an AI trigger.
- A migrated remote tab may reattach by session id without reusable connection parameters; it cannot be cloned until the user creates a new managed connection.
- Conversation history may span environments, while every proposal and execution remains frozen to one verified terminal context.
- Every execution requires explicit approval and remains idempotent.
