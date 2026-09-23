# Terminal context management review

Baseline: `main` at `cacd426`; initial implementation `8829944` and corrective commit `77feab7` plus final drag/i18n fixes. Independent Standards and Spec reviewers rechecked the corrections on 2026-09-22.

## Standards

- Fixed: draft preparation was bound after asynchronous provider session creation, allowing concurrent requests to leave orphan conversations. It is now claimed before provider work. HTTP coverage asserts one success, one rejection and no extra conversation.
- Fixed: handles appeared on every selected command. Only the outermost selection boundaries now have handles; window pointer tracking survives a handle moving between blocks. Browser coverage checks unique handles and extends across three blocks.
- Fixed (judgement: duplicated code): pane/tab cleanup now uses the shared floating-frame storage key helper.

Re-review: no remaining findings.

## Spec

- Fixed: ChatGPT pretty-printed a context measured as compact JSON, potentially exceeding 64 KiB. It now sends the same compact JSON representation as the frozen snapshot.
- Fixed: cache eviction could invalidate prepared IDs before ten minutes. Existing valid IDs are never evicted; the bounded cache explicitly rejects new preparations at capacity. Running output refresh is sampled once a second.

Re-review: no remaining findings.

Summary: Standards 3 findings resolved; Spec 2 findings resolved. Neither axis has an outstanding issue.

## Verification scope

Core HTTP regression covers frozen output, incremental delivery, manual repeat, no-terminal-content with history retained, cross-pane ownership and ledger isolation, new conversations, persistence reload, rejected foreign/expired/reused IDs, concurrent draft creation, provider failure and cancellation. Browser regression covers provider controls, whole-block highlight/list synchronization, range dragging, clear fallback, movable/resizable/reopenable floating UI, cursor following, F8/Esc and existing terminal input/split behavior.

Real-provider credentials, live SSH/Docker environments, actual Chinese IME composition and long-running full-screen/high-throughput programs remain manual acceptance items. Exact terminal locations unavailable after clearing, discarded scrollback or partial-line reflow deliberately fall back to the attachment list.
