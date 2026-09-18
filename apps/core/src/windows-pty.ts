import { spawn, type IPty } from "node-pty";

import type {
  PtyFactory,
  PtyProcess,
  PtySpawnOptions,
} from "./terminal-session.js";

export interface WindowsPtyFactoryOptions {
  cwd: string;
  shell?: string;
  integrationPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function createWindowsPtyFactory(
  options: WindowsPtyFactoryOptions,
): PtyFactory {
  if (process.platform !== "win32") {
    throw new Error("The Windows PTY adapter requires Windows");
  }

  const shell = options.shell ?? "powershell.exe";
  const environment = toPtyEnvironment(options.env ?? process.env);
  return ({ cols, rows, shellIntegrationToken }: PtySpawnOptions) => {
    const args = options.integrationPath === undefined
      ? ["-NoLogo"]
      : [
          "-NoLogo",
          "-NoExit",
          "-Command",
          `. '${options.integrationPath.replaceAll("'", "''")}' -StackBridgeIntegrationToken '${(shellIntegrationToken ?? "").replaceAll("'", "''")}'`,
        ];
    const process = createNodePtyProcess(shell, args, {
      cols,
      rows,
      cwd: options.cwd,
      env: environment,
    });
    return process;
  };
}

export function createNodePtyProcess(
  command: string,
  args: string[],
  options: {
    cols: number;
    rows: number;
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): PtyProcess {
  return new NodePtyProcess(
    spawn(command, args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: toPtyEnvironment(options.env ?? process.env),
      useConpty: process.platform === "win32",
      useConptyDll: process.platform === "win32",
    }),
  );
}

class NodePtyProcess implements PtyProcess {
  constructor(private readonly pty: IPty) {}

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  kill(): void {
    this.pty.kill();
  }

  onData(listener: (data: string) => void): () => void {
    const disposable = this.pty.onData(listener);
    return () => disposable.dispose();
  }

  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): () => void {
    const disposable = this.pty.onExit(listener);
    return () => disposable.dispose();
  }
}

function toPtyEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (environment.TERM === undefined || environment.TERM === "" || environment.TERM === "dumb") {
    environment.TERM = "xterm-256color";
  }
  environment.COLORTERM ||= "truecolor";
  return environment;
}
