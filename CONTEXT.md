# StackBridge domain context

StackBridge is a local-first terminal and AI workbench. Its central safety rule is that a saved logical target is never treated as proof of the runtime instance currently receiving work.

## Glossary

### ConnectionProfile

A saved description of how Core reaches an external system. It may contain an SSH endpoint, jump profile references, a credential reference, or an explicit Docker context name. It never contains a password, private key, or other secret value.

### ExecutionTarget

A user-visible logical work object such as `dev-main` or `dev-main/ros-dev`. A Docker container name is only a selector on an ExecutionTarget; it is not instance identity.

Avoid the former name `TargetSpec` in new code. The serialized creation and persistence shape is `ExecutionTarget`.

### RuntimeBinding

An ephemeral, verified attachment between an ExecutionTarget and one concrete runtime instance. It records the identity evidence required for its target kind, including the SSH host key and, for Docker, daemon identity, full container ID, container start time, container init process start ticks, running state, mounts digest, numeric execution UID, resolved shell or explicit lack of one, default cwd, roots, and capabilities.

### ExecutionRequest

An internal request produced by the trusted gateway after resolving an Agent Session and an approval. It carries `agentSessionId`, `expectedBindingId`, `operationId`, and `approvalId`; it does not allow a caller to override `targetId`.

### ConversationSession

The user-visible, continuous AI conversation. It maps to one Codex thread and may include history from several terminal tabs and environment layers. Changing terminal focus changes the default environment for the next turn; it never retargets an existing turn or proposal.

### TerminalSession

One live terminal tab, its PTY, ordered output replay, write lease, Shell state, and environment stack. A TerminalSession stays alive when the browser detaches and is the only place where approved same-Shell commands may be submitted.

### EnvironmentFrame

One layer in a TerminalSession connection stack, such as local Windows, an SSH host, or a Docker container. It records its parent and verified RuntimeBinding when available. A container display name is not identity; a rebuilt container creates a different binding.

### AgentSession

A per-turn execution scope frozen from the selected TerminalSession, EnvironmentFrame, RuntimeBinding, cwd, Shell, context version, and input version. It is distinct from ConversationSession. Changing UI focus does not retarget it.

### CommandBlock

A command plus its terminal-output range, environment, cwd, Shell, user, source, timestamps, exit status, and capture quality. Interactive PTY output is intentionally recorded as one terminal stream rather than pretending stdout and stderr remained separate.

### CommandProposal

An immutable AI suggestion owned by Core. It is bound to the AgentSession that generated it, expires after five minutes, and can be executed at most once after an explicit decision. Editing a command creates a new proposal.

### ExecutionOperation

The durable idempotency record created before an approved command is submitted to its Shell. Retries and refreshes query the same operation ID; they do not submit the command again.

## Invariants

1. A ConnectionProfile describes how to connect; it does not identify the connected instance.
2. An ExecutionTarget is logical and persistent; a RuntimeBinding is verified and replaceable.
3. Any runtime identity change creates a new binding generation and invalidates work approved against the old binding.
4. Models and untrusted clients cannot choose target identity, binding identity, caller authority, or approval capability.
5. Human terminal prompts, OSC data, logs, container names, and UI focus are never authorization evidence.
6. A ConversationSession may span environments, but every AgentSession and CommandProposal is frozen to exactly one verified execution scope.
7. Approved commands execute only in the original idle Shell while the approving browser owns its write lease and the input line is empty.
