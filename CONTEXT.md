# StackBridge domain context

StackBridge is a local-first terminal and AI workbench. Its central safety rule is that a saved logical target is never treated as proof of the runtime instance currently receiving work.

## Glossary

### ConnectionProfile

A saved description of how Core reaches an external system. It may contain an SSH endpoint, jump profile references, a credential reference, or an explicit Docker context name. It never contains a password, private key, or other secret value.

### ExecutionTarget

A user-visible logical work object such as `dev-main` or `dev-main/ros-dev`. A Docker container name is only a selector on an ExecutionTarget; it is not instance identity.

Avoid the former name `TargetSpec` in new code. The serialized creation and persistence shape is `ExecutionTarget`.

### RuntimeBinding

An ephemeral, verified attachment between an ExecutionTarget and one concrete runtime instance. It records the identity evidence required for its target kind, including the SSH host key and, for Docker, daemon identity, full container ID, start time, mounts digest, principal, roots, and capabilities.

### ExecutionRequest

An internal request produced by the trusted gateway after resolving an Agent Session and an approval. It carries `agentSessionId`, `expectedBindingId`, `operationId`, and `approvalId`; it does not allow a caller to override `targetId`.

### Agent Session

A server-side AI session frozen to one ExecutionTarget and RuntimeBinding. Changing UI focus does not retarget it. Its runtime schema and gateway enforcement belong to a later slice.

## Invariants

1. A ConnectionProfile describes how to connect; it does not identify the connected instance.
2. An ExecutionTarget is logical and persistent; a RuntimeBinding is verified and replaceable.
3. Any runtime identity change creates a new binding generation and invalidates work approved against the old binding.
4. Models and untrusted clients cannot choose target identity, binding identity, caller authority, or approval capability.
5. Human terminal prompts, OSC data, logs, container names, and UI focus are never authorization evidence.
