# ADR-0002: Keep conversation continuity separate from frozen execution scope

- Status: Accepted
- Date: 2026-09-18

## Context

A terminal assistant is most useful when one conversation can explain a sequence that crosses local Windows, an SSH host, and a Docker container. Treating the whole conversation as one mutable execution target makes old suggestions dangerous: switching tabs or rebuilding a container could silently retarget a command. Treating every environment change as a new conversation loses the history the user needs.

The first specification also separated the human Shell from Agent execution. The confirmed product workflow instead requires an approved command to run in the exact same interactive Shell so that `cd`, exported variables, virtual environments, aliases, and shell functions remain effective.

## Decision

- `ConversationSession` is continuous and maps to one Codex thread. It may contain messages and command history from several environments.
- Every question creates an `AgentSession` that freezes the selected `TerminalSession`, `EnvironmentFrame`, `RuntimeBinding`, cwd, Shell, context version, and input version.
- Every `CommandProposal` is immutable, belongs to that AgentSession, expires after five minutes, and can be approved at most once.
- Core, not the model or browser, owns the frozen target fields and creates the `operationId` before submission.
- Approval succeeds only when the original environment and binding still exist, the Shell is idle, the input line is empty, context/input versions still match, and the approving browser owns the terminal write lease.
- The approved command is submitted to the original interactive Shell. The model never writes terminal bytes directly.
- Environment changes are appended to the conversation timeline. Changing terminal focus changes only the default target for the next turn.
- If identity or Shell state cannot be verified, StackBridge may still explain captured output and offer a copyable command, but it disables confirmed automatic submission.

## Consequences

- A single conversation can answer “why did it fail after entering the container?” without losing host history.
- Old cards cannot follow focus to a different tab, host, container, cwd, or rebuilt runtime.
- Same-Shell state is preserved without exporting the process environment to the model.
- Interactive programs, password prompts, unknown Shells, and stale bindings intentionally reduce capability instead of accepting an unsafe best guess.
- Future isolated or unattended Agent workflows remain a separate execution mode and must not inherit this same-Shell authority implicitly.

## Explicit recheck recovery (2026-09-23)

A stale or expired, never-submitted proposal can be explicitly rechecked against
its original terminal. This creates a new pending proposal and AgentSession with
current context/input versions; it never mutates the old frozen scope, retargets
to UI focus, calls the model, or executes a command. Terminal/frame/binding, cwd,
Shell and user must still match, and verification, write lease, idle Shell and
empty input remain required. The user reviews the command and original target
and makes a separate execute/insert decision, which revalidates the new scope.
The replacement link and both scopes are persisted atomically for idempotent
retries. Submitted/unknown operations cannot be reauthorized through this path.
