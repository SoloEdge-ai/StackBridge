import { randomBytes, randomUUID } from "node:crypto";

import type {
  CreateTerminalSessionRequest,
  RemoteSessionSnapshot,
} from "@stackbridge/protocol";

import type { RemoteSessionService } from "./remote-session-manager.js";
import { bashIntegrationScript, zshIntegrationScript } from "./shell-integration.js";
import type {
  PtyProcess,
  TerminalSessionInitialContext,
} from "./terminal-session.js";
import { createNodePtyProcess } from "./windows-pty.js";

type RemoteTerminalRequest = Extract<
  CreateTerminalSessionRequest,
  { kind: "ssh" | "docker" }
>;

export interface RemotePtyLaunch {
  pty: PtyProcess;
  initialContext: TerminalSessionInitialContext;
}

export function createRemotePtyLauncher(
  remoteSessions: RemoteSessionService,
  localCwd: string,
): (
  request: RemoteTerminalRequest,
  snapshot: RemoteSessionSnapshot,
) => Promise<RemotePtyLaunch> {
  return async (request, snapshot) => {
    if (snapshot.shell === null) {
      throw new Error("The verified target does not provide an interactive shell");
    }
    const shellIntegrationToken = randomBytes(24).toString("base64url");
    await installRemoteShellIntegration(remoteSessions, snapshot, shellIntegrationToken);
    const remoteCommand = buildRemoteCommand(request, snapshot);
    const args = [
      "-tt",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ClearAllForwardings=yes",
      "-p",
      String(request.port),
      "-l",
      request.user,
      request.host,
      remoteCommand,
    ];
    const pty = createNodePtyProcess("ssh.exe", args, {
      cols: request.cols,
      rows: request.rows,
      cwd: localCwd,
      env: process.env,
    });

    const localEnvironment = {
      id: `env.${randomUUID()}`,
      kind: "local" as const,
      label: "本地 Windows",
      verified: true,
      bindingId: `local.${process.pid}`,
    };
    const sshEnvironment = {
      id: `env.${randomUUID()}`,
      parentId: localEnvironment.id,
      kind: "ssh" as const,
      label: `${request.user}@${request.host}`,
      verified: true,
      bindingId: request.kind === "ssh" ? snapshot.bindingId : `ssh.${snapshot.hostBootId}`,
      host: request.host,
    };
    const environments = request.kind === "docker"
      ? [
          localEnvironment,
          sshEnvironment,
          {
            id: `env.${randomUUID()}`,
            parentId: sshEnvironment.id,
            kind: "docker" as const,
            label: `Docker: ${request.container}`,
            verified: true,
            bindingId: snapshot.bindingId,
            host: request.host,
            containerId: snapshot.containerId!,
          },
        ]
      : [localEnvironment, sshEnvironment];
    return {
      pty,
      initialContext: {
        environments,
        cwd: snapshot.defaultCwd,
        shell: shellName(snapshot.shell),
        user: request.kind === "docker" ? request.containerUser : request.user,
        shellState: "unknown",
        shellIntegrationToken,
      },
    };
  };
}

async function installRemoteShellIntegration(
  remoteSessions: RemoteSessionService,
  snapshot: RemoteSessionSnapshot,
  shellIntegrationToken: string,
): Promise<void> {
  const bash = Buffer.from(bashIntegrationScript(shellIntegrationToken), "utf8").toString("base64");
  const zsh = Buffer.from(zshIntegrationScript(shellIntegrationToken), "utf8").toString("base64");
  const result = await remoteSessions.execute(snapshot.sessionId, {
    cwd: snapshot.defaultCwd,
    program: "/bin/sh",
    args: [
      "-c",
      'umask 077; mkdir -p "$HOME/.sbridge/shell" && printf %s "$1" | base64 -d > "$HOME/.sbridge/shell/bashrc" && printf %s "$2" | base64 -d > "$HOME/.sbridge/shell/.zshrc"',
      "stackbridge",
      bash,
      zsh,
    ],
    timeoutMs: 15_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to install temporary shell integration: ${result.stderr.trim()}`);
  }
}

function buildRemoteCommand(
  request: RemoteTerminalRequest,
  snapshot: RemoteSessionSnapshot,
): string {
  const launchShell = shellLaunchCommand(snapshot.shell!);
  if (request.kind === "ssh") return launchShell;
  if (snapshot.containerId === undefined) {
    throw new Error("Verified Docker terminal is missing the container instance id");
  }
  const dockerArgs = [
    "docker",
    "--context",
    request.contextName,
    "exec",
    "-it",
    "-u",
    request.containerUser,
    "-w",
    request.cwd,
    snapshot.containerId,
    "/bin/sh",
    "-lc",
    launchShell,
  ];
  return dockerArgs.map(posixQuote).join(" ");
}

function shellLaunchCommand(shell: string): string {
  if (shell.endsWith("/zsh") || shell === "zsh") {
    return 'export STACKBRIDGE_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"; export ZDOTDIR="$HOME/.sbridge/shell"; exec ' +
      `${posixQuote(shell)} -i`;
  }
  return `exec ${posixQuote(shell)} --rcfile "$HOME/.sbridge/shell/bashrc" -i`;
}

function shellName(shell: string): string {
  return shell.endsWith("/zsh") ? "zsh" : "bash";
}

function posixQuote(value: string): string {
  if (value.includes("\0")) throw new Error("NUL is not valid in a remote shell argument");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
