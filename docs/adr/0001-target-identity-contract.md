# ADR-0001: Separate connection, target, binding, and execution request

- Status: Accepted
- Date: 2026-09-17

## Context

The product specification uses `ExecutionTarget` for the saved user concept and `TargetSpec` in an illustrative TypeScript block. Leaving both names active would let Core, the gateway, and a future Go runtime assign different meanings to the same target data. Container names and SSH aliases also cannot prove which runtime instance is currently attached.

## Decision

- `ConnectionProfile` is the saved connection method. Secrets are represented only by `credentialRef`.
- `ExecutionTarget` is the only name for the persisted logical target. The former `TargetSpec` example is treated as the serialized shape of `ExecutionTarget`, not as a second domain type.
- `RuntimeBinding` is a versioned, target-kind-specific record of a verified instance. SSH and Docker bindings require a numeric execution UID plus the resolved shell and default cwd. Docker bindings additionally require the verified SSH host key, host boot ID, Docker daemon ID, full container ID, container start time, container init process start ticks, running state, mounts digest, workspace roots, and capabilities. A missing container shell is recorded explicitly as `null` and limits advertised capabilities.
- `ExecutionRequest` is a strict internal gateway contract. It contains an `expectedBindingId` and rejects extra caller-supplied fields such as `targetId`.
- Every contract object carries `schemaVersion: 2`. The contract moved from version 1 to 2 when container init process start ticks became required; future breaking changes require another version or explicit compatibility handling.
- The TypeScript Zod schemas in `@stackbridge/protocol` are authoritative for M0-B0. The shared JSON fixture is consumed by both TypeScript and the Go compatibility test.

## Consequences

- Rebuilding or restarting a container must produce a new binding generation even when its logical target and container selector are unchanged.
- A named Docker context remains connection configuration; the resulting daemon identity must still be verified in the RuntimeBinding.
- Shape validation alone does not prove referential integrity or binding freshness. The future target store and Tool Gateway must resolve the Agent Session, compare the current binding, and reject stale approvals immediately before execution.
- Live SSH, Docker, and Go runtime claims are scoped separately by the M0-B1 verification record.
