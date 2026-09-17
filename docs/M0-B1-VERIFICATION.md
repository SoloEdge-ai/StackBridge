# M0-B1 SSH and Docker verification

Updated: 2026-09-17
Status: verified on one Ubuntu amd64 SSH host and one Ubuntu 22.04 container fixture

## Result

The M0-B1 vertical slice now crosses the real boundary from the Windows Core process, through system OpenSSH, into the Linux Go runtime, and then through the selected Docker context into a verified container instance. Runtime requests are line-delimited JSON and command execution uses a program plus argv; arbitrary commands are not interpolated into the SSH remote command.

The SSH client uses `BatchMode=yes`, `StrictHostKeyChecking=yes`, `ForwardAgent=no`, `ClearAllForwardings=yes`, no remote PTY, and the fixed runtime path `.local/lib/stackbridge/runtime/m0-b1/stackbridge-runtime`. A non-blocking, cancellable fixed-command preflight lets OpenSSH itself apply the user's effective known-hosts configuration, including Windows paths with spaces and `__PROGRAMDATA__`. After that process exits, Core reads the locally generated authentication log, retrieves the exact trusted public-key line OpenSSH used, writes only that key to a private temporary `known_hosts`, and pins a fresh non-multiplexed runtime connection to it. DNS key trust, `KnownHostsCommand`, host-IP fallback, key updates, proxies, and connection sharing are disabled for this channel. The matching SHA-256 fingerprint is published only after a valid runtime response; a server banner or remote stderr cannot replace it.

## Verified environment

| Item | Verified value |
|---|---|
| SSH fixture | `friden-dev-cube` |
| Host OS | Ubuntu 22.04.5 LTS, Linux amd64 |
| Host principal | UID/GID `1000:1000`, user `friden` |
| Host key | ED25519 `SHA256:thbpCeLcrbAs6ri55e0/FQhVUPYoija4TjxJQh84Z90` |
| Host boot ID | `b1e65eec-132d-4ec6-8fcb-0aedd28ed9b5` |
| Docker Engine | 29.4.0, daemon ID `8f1af5c2-6d80-4128-8caa-f86eb97de346` |
| Container fixture | `ubuntu:22.04`, name `stackbridge-m0b1-ubuntu22`, label `io.stackbridge.fixture=m0b1` |
| Runtime binary | static linux/amd64, SHA-256 `9792be01e50c62446c9cdd7f04a07036cd5e5c0b874c341d23e1c64786eaa704` |
| Go build/test toolchain | `golang:1.24-bookworm` isolated build container |

The host did not have Go installed. Builds and Go tests therefore ran in the isolated toolchain container; the resulting static binary was installed under the SSH user's fixed StackBridge runtime path. No host package installation or Docker permission change was made.

## Evidence exercised

- Go consumes the authoritative `packages/protocol/fixtures/m0-b0-target-contract.json` fixture.
- SSH handshake returns runtime instance ID, boot ID, numeric principal, platform, architecture, default cwd, shell, and capabilities.
- Core derives the fingerprint from the exact trusted public key used as the runtime connection's isolated `known_hosts` pin.
- Host and container argv preserve spaces, quotes, Unicode, semicolons, and a literal `$()` value without shell evaluation.
- Same-named `identity.txt` files returned different expected values: `HOST:friden-dev-cube` on the host and `CONTAINER:ubuntu22-recreated` in the container.
- Docker discovery binds the selected context to daemon ID, full container ID, container start time, container init process start ticks, running state, UID/GID, cwd, shell, mounts digest, and capabilities.
- Docker execution re-inspects the daemon and container identity immediately before calling `docker exec`, pins `--user` to the verified numeric UID:GID, and uses a fixed in-container guard to compare PID 1 start ticks before starting the requested argv. A restart in the inspect/exec window therefore refuses instead of retargeting.
- Host timeouts kill the spawned Linux process group. Docker execution uses a copied static StackBridge helper that owns timeout and result framing inside the container; it does not infer control state from target stderr or exit codes. If the host-side Docker client times out first, the protocol reports `execution_unknown` rather than claiming cancellation.
- A target that emitted the former stale-binding marker and exited `124` was returned as an ordinary `timedOut: false` process result, confirming that target output cannot forge the helper's control envelope.
- A live 150 ms Docker timeout returned `timedOut: true`; a subsequent `docker top` showed only the fixture's intended `sleep infinity` process and no surviving workload.
- Recreating the same-named container changed its full ID. An execution carrying the old evidence was rejected with `stale_binding`; a fresh binding executed successfully.
- Unit tests cover structured transport, pinned SSH launch arguments, server-banner spoof resistance, request/response limits, blank protocol lines, direct OS execution, Docker metadata parsing, mount digest ordering, and mutable binding evidence. The Go suite also passes the race detector and `go vet`.

The live Core suite is opt-in:

```powershell
$env:STACKBRIDGE_SSH_FIXTURE = 'friden-dev-cube'
$env:STACKBRIDGE_SSH_USER = 'friden'
$env:STACKBRIDGE_DOCKER_FIXTURE = 'stackbridge-m0b1-ubuntu22'
pnpm --filter @stackbridge/core test -- ssh-runtime-client.integration.test.ts
```

The fixture container is intentionally still running for follow-up work. It is uniquely named and labeled; it must be label-checked before replacement or removal.

## Remaining boundaries

- Runtime deployment is still a manual prototype. Signed/versioned distribution, atomic upgrade, compatibility negotiation, rollback, and automatic binary digest verification are not implemented.
- Only Ubuntu 22.04 on amd64 was verified. Ubuntu 24.04, arm64, jump hosts, host-certificate/`@cert-authority` profiles, non-default Docker contexts, rootless Docker, and shell-less images remain unverified. The container helper itself does not require GNU user tools or a shell.
- M0-B1 covers handshake and ordinary argv execution. Remote PTY, file APIs, task persistence, cancellation confirmation, reconnect, output streaming/backpressure, and durable binding storage remain later work.
- The M0-B1 protocol revalidates runtime evidence but is not yet wired through Agent Session, approval, action-hash, or operation-deduplication enforcement.
