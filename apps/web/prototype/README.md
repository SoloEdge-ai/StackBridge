# Throwaway AI workspace prototype

Question: which structure best combines a terminal, visible per-message context,
and a continuous AI conversation? This is the original interactive Codex artifact,
archived as a primary source, not production code.

Run from the repository root:

```sh
node apps/web/prototype/serve.mjs
```

Use the bottom arrows to compare A (right companion panel), B (bottom workspace),
and C (conversation-focused workspace). Requests, terminal commands and responses
are simulated. No credentials, backend calls, PTY writes or persistent storage.

## Verdict — 2026-09-23

The user approved proceeding after evaluating variant A. Implement a stable,
resizable right AI panel plus a bounded Quick Ask, sharing conversation, draft,
provider/model and per-message terminal attachments. Keep one visible composer.
Do not promote B/C or the mock state machine into production. The implementation
is independently tested on `codex/ai-workspace-redesign`.

Keep this branch out of main. The original Codex host supplies optional icons and
tweak controls; the standalone host remains usable without those enhancements.
