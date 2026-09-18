import { randomBytes, randomUUID } from "node:crypto";

import type {
  CreateTerminalSessionRequest,
  RemoteSessionSnapshot,
} from "@stackbridge/protocol";

import type { RemoteSessionService } from "./remote-session-manager.js";
import { localEnvironmentLabel } from "./environment-labels.js";
import {
  bashDockerPromptScript,
  bashIntegrationScript,
  remoteUtf8LocaleBootstrap,
  zshDockerPromptScript,
  zshIntegrationScript,
} from "./shell-integration.js";
import { dockerShellIntegrationToken } from "./shell-integration-token.js";
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
    await installRemoteShellIntegration(
      remoteSessions,
      snapshot,
      shellIntegrationToken,
      request.kind === "docker",
    );
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
      label: localEnvironmentLabel,
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
  commandScoped: boolean,
): Promise<void> {
  const integrationToken = commandScoped
    ? dockerShellIntegrationToken(shellIntegrationToken)
    : shellIntegrationToken;
  const bashScript = commandScoped
    ? bashDockerPromptScript(integrationToken)
    : bashIntegrationScript(integrationToken);
  const zshScript = commandScoped
    ? zshDockerPromptScript(integrationToken)
    : zshIntegrationScript(integrationToken);
  const bash = Buffer.from(bashScript, "utf8").toString("base64");
  const zsh = Buffer.from(zshScript, "utf8").toString("base64");
  const dockerIntegrationToken = dockerShellIntegrationToken(shellIntegrationToken);
  const dockerBash = Buffer.from(
    bashDockerPromptScript(dockerIntegrationToken),
    "utf8",
  ).toString("base64");
  const dockerZsh = Buffer.from(
    zshDockerPromptScript(dockerIntegrationToken),
    "utf8",
  ).toString("base64");
  const result = await remoteSessions.execute(snapshot.sessionId, {
    cwd: snapshot.defaultCwd,
    program: "/bin/sh",
    args: [
      "-c",
      'umask 077; mkdir -p "$HOME/.sbridge/shell" && printf %s "$1" | base64 -d > "$HOME/.sbridge/shell/bashrc" && printf %s "$2" | base64 -d > "$HOME/.sbridge/shell/.zshrc" && printf %s "$3" | base64 -d > "$HOME/.sbridge/shell/docker-bashrc" && printf %s "$4" | base64 -d > "$HOME/.sbridge/shell/docker-zshrc"',
      "stackbridge",
      bash,
      zsh,
      dockerBash,
      dockerZsh,
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
  const context = request.kind === "ssh"
    ? `${localEnvironmentLabel} → ${request.user}@${request.host}`
    : `${localEnvironmentLabel} → ${request.user}@${request.host} → Docker: ${request.container}`;
  const contextBase64 = Buffer.from(context, "utf8").toString("base64");
  if (request.kind === "ssh") {
    return `export STACKBRIDGE_CONTEXT_B64=${posixQuote(contextBase64)}; ${launchShell}`;
  }
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
    "-e",
    `STACKBRIDGE_CONTEXT_B64=${contextBase64}`,
    snapshot.containerId,
    "/bin/sh",
    "-lc",
    launchShell,
  ];
  return dockerArgs.map(posixQuote).join(" ");
}

function shellLaunchCommand(shell: string): string {
  if (shell.endsWith("/zsh") || shell === "zsh") {
    return `${remoteUtf8LocaleBootstrap}; ` +
      'export STACKBRIDGE_USER_ZDOTDIR="${ZDOTDIR-}"; export STACKBRIDGE_USER_ZDOTDIR_SET="${ZDOTDIR+x}"; export ZDOTDIR="$HOME/.sbridge/shell"; exec ' +
      `${posixQuote(shell)} -i`;
  }
  return `${remoteUtf8LocaleBootstrap}; exec ${posixQuote(shell)} --rcfile "$HOME/.sbridge/shell/bashrc" -i`;
}

function shellName(shell: string): string {
  return shell.endsWith("/zsh") ? "zsh" : "bash";
}

function posixQuote(value: string): string {
  if (value.includes("\0")) throw new Error("NUL is not valid in a remote shell argument");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
