# ADR-0001: Separate connection, target, binding, and execution request

- Status: Accepted
- Date: 2026-09-17

## Context

The product specification uses `ExecutionTarget` for the saved user concept and `TargetSpec` in an illustrative TypeScript block. Leaving both names active would let Core, the gateway, and a future Go runtime assign different meanings to the same target data. Container names and SSH aliases also cannot prove which runtime instance is currently attached.

## Decision

- `ConnectionProfile` is the saved connection method. Secrets are represented only by `credentialRef`.
- `ExecutionTarget` is the only name for the persisted logical target. The former `TargetSpec` example is treated as the serialized shape of `ExecutionTarget`, not as a second domain type.
- `RuntimeBinding` is a versioned, target-kind-specific record of a verified instance. Docker bindings require the verified SSH host key, host boot ID, Docker daemon ID, full container ID, container start time, mounts digest, principal, workspace roots, and capabilities.
- `ExecutionRequest` is a strict internal gateway contract. It contains an `expectedBindingId` and rejects extra caller-supplied fields such as `targetId`.
- Every contract object carries `schemaVersion: 1`. Breaking changes require a new version or explicit compatibility handling.
- The TypeScript Zod schemas in `@stackbridge/protocol` are authoritative for M0-B0. The shared JSON fixture is the input for the future Go compatibility test.

## Consequences

- Rebuilding or restarting a container must produce a new binding generation even when its logical target and container selector are unchanged.
- A named Docker context remains connection configuration; the resulting daemon identity must still be verified in the RuntimeBinding.
- Shape validation alone does not prove referential integrity or binding freshness. The future target store and Tool Gateway must resolve the Agent Session, compare the current binding, and reject stale approvals immediately before execution.
- M0-B0 does not claim that SSH, Docker, a Go runtime, or target execution has been tested.
