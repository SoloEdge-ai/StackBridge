# M0-B2 runtime automatic deployment and UI verification

Updated: 2026-09-18  
Status: verified on Windows Core → Ubuntu 22.04 amd64 SSH host → Ubuntu 22.04 Docker fixture

## Result

The browser now exposes a usable SSH/Docker workspace. Core resolves and pins the host key with the user's system OpenSSH configuration without requiring a preinstalled runtime, detects Linux architecture, compares the remote runtime version and digest, and requests explicit approval before the first install or an upgrade. The one-time approval is bound to the complete SSH/Docker request and the proposed host-key fingerprint, runtime version, architecture and digest; changes force a fresh proposal.

Approved artifacts are uploaded over pinned SFTP and installed under the authenticated login user's home:

```text
~/.sbridge/
  staging/
  runtimes/<version>/linux-<arch>/<sha256>/stackbridge-runtime
  current -> runtimes/...
  previous -> runtimes/...   # after an upgrade
  state/install.lock
```

Managed directories are mode `0700`; the runtime is mode `0755`. Every managed path component and the staged file's resolved path are checked without following directory symlinks outside the real root. The runtime verifies its staged SHA-256 digest, platform, architecture and protocol before moving itself into the content-addressed directory and atomically replacing `current`. A failed post-install handshake invokes compare-and-swap rollback to `previous`. No `sudo`, remote package manager, Node/Python runtime, public RPC port, SSH agent forwarding, `curl | sh`, or host-key bypass is used.

## Verified environment

| Item | Verified value |
|---|---|
| Windows Core | Node.js 22.14.0, pnpm 10.33.0, OpenSSH for Windows 9.5p2 |
| SSH fixture | `friden-dev-cube`, Ubuntu 22.04.5 LTS, linux/amd64, user `friden` |
| Managed path | `/home/friden/.sbridge` |
| Runtime | `0.1.0-dev`, protocol 2, static linux/amd64 |
| Docker fixture | `stackbridge-m0b1-ubuntu22`, Ubuntu 22.04, UID/GID `0:0` |
| Compatibility smoke | fresh `ubuntu:24.04` container executed the bundled amd64 `version` mode |
| Bundled builds | linux/amd64 and linux/arm64 |

## Evidence exercised

- A host with no managed `~/.sbridge/current` produced a deployment proposal before any upload.
- The approved amd64 artifact was uploaded and installed, then a second connection with deployment approval disabled reused the same digest without writing.
- Runtime protocol 2 reports runtime version and executable digest in both `version` and handshake results.
- Browser authentication, local-terminal navigation, SSH connection, runtime identity/fingerprint display, manual structured `/usr/bin/uname -a`, disconnect, Docker selection and container execution were exercised through the real UI.
- The real SSH/Docker integration suite passed after recreating the labeled fixture state; structured argv, Docker identity binding, timeout control and stale-binding rejection remain intact.
- Go unit tests run in `golang:1.24-bookworm`; amd64 and arm64 static binaries are cross-built with `CGO_ENABLED=0`.
- A fresh Ubuntu 24.04 container successfully executed the same amd64 static artifact and returned the expected protocol/version/digest identity.

## Remaining boundaries

- ARM64 is cross-built but has not run on physical ARM64 hardware; it is not marked live-verified.
- Unknown first-use SSH host keys still follow OpenSSH strict behavior; the current UI does not implement an interactive trust-on-first-use flow, passwords, key passphrases or MFA askpass.
- The repository bundles development artifacts and verifies SHA-256. Formal desktop-package signing and separately signed release manifests remain future release work.
- Remote interactive PTY, file tools, saved connection profiles, reconnect persistence, long-task supervision and UI progress streaming are later slices.
