# Domain docs

StackBridge uses a single domain context.

## Before exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read ADRs under `docs/adr/` that affect the area being changed.
- If either location is absent, proceed without treating the absence as an error.

## Vocabulary

Use the terms defined in `CONTEXT.md` in code, tests, issues, and design notes. If a needed concept is missing, record the gap instead of silently introducing a synonym.

## Decisions

If proposed work conflicts with an ADR, call out the conflict explicitly and either follow the ADR or add a superseding decision record.

Expected layout:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```
