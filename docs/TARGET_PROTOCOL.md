# M0-B0 target identity protocol

Updated: 2026-09-17  
Status: TypeScript runtime schemas and language-neutral fixtures verified; the M0-B1 Go consumer and live SSH/Docker executor are also verified.

## Authority and versioning

The exported Zod schemas in `packages/protocol/src/targets.ts` are the current runtime authority. Every top-level object has `schemaVersion: 2` and is strict: unknown fields are rejected instead of silently removed. Version 2 adds container init process start ticks so an exec-time guard can reject restart races.

The fixture at `packages/protocol/fixtures/m0-b0-target-contract.json` contains local, SSH, and Docker examples. The Go runtime parses this same fixture in its contract suite rather than maintaining an independent example.

## Contracts

### ConnectionProfile

- `ssh`: endpoint, port, remote user, optional credential reference, and explicit jump profile references.
- `docker-daemon`: an explicit Docker context name.
- Secret values are not fields in either variant.

### ExecutionTarget

- `local`: logical local target and platform.
- `ssh`: logical target linked to an SSH ConnectionProfile.
- `docker`: logical child target linked to a parent target and Docker daemon profile, with a container selector and requested user.

`containerSelector` is not identity. It may resolve to a different instance after a restart or rebuild.

### RuntimeBinding

- `local`: local runtime instance, generation, principal, platform, roots, and capabilities.
- `ssh`: additionally requires the verified host key, host boot ID, numeric execution UID, resolved shell, and default cwd.
- `docker`: additionally requires the SSH host identity, daemon identity, full 64-character container ID, container start timestamp, container init process start ticks, running state, numeric execution UID, default cwd, explicit shell-or-no-shell value, and mounts digest.

Changing any instance identity evidence requires a new `bindingId` or generation. Consumers must compare the current binding rather than trusting a previously parsed object.

### ExecutionRequest

The request supports a structured `argv` command and a separately labelled `shell` command. It includes the Agent Session, expected binding, environment profile, timeout, operation, and approval identifiers. The strict schema rejects a caller-supplied `targetId`.

The request is an internal trusted-gateway contract, not a payload that may be accepted directly from a model. The gateway is responsible for injecting identity and approval fields.

## Threat checks and remaining enforcement

| Threat | M0-B0 contract response | Remaining implementation |
|---|---|---|
| Secret embedded in a saved connection | Profiles expose `credentialRef`, not password/private-key fields; strict objects reject unknown keys | Credential vault adapter |
| Model or client chooses another target | ExecutionRequest has no `targetId` and rejects unknown fields | Gateway must build the request from its server-side Agent Session |
| SSH host key changes | SSH and Docker bindings require `verifiedHostKey`; M0-B1 isolates one existing trusted key into a temporary `known_hosts`, pins the runtime connection to that key, and records its fingerprint | First-use and changed-key trust UI |
| Docker context points at another daemon | Docker binding records `dockerDaemonId`; M0-B1 re-reads it before execution | Durable binding store and user-facing context management |
| Container is rebuilt or restarted | Binding records full ID, container start time, init process start ticks, generation, and mounts digest; M0-B1 rechecks these and its in-container guard refuses after a restart race | Binding store and approval check must also invalidate stale work |
| UI tab changes during approval | Request is pinned to `agentSessionId` and `expectedBindingId` | Approval service must re-check both immediately before dispatch |
| Prompt, OSC, or logs claim a different target | No protocol field derives identity from terminal output | Adapters must treat terminal output as untrusted bytes |

Store-level reference checks, Agent Session schemas, approval capabilities, path containment, and operation deduplication are intentionally deferred to subsequent slices. Live runtime evidence is recorded in [M0-B1 verification](M0-B1-VERIFICATION.md).
