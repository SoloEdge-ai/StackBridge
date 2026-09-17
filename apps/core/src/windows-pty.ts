import { spawn, type IPty } from "node-pty";

import type {
  PtyFactory,
  PtyProcess,
  PtySpawnOptions,
} from "./terminal-session.js";

export interface WindowsPtyFactoryOptions {
  cwd: string;
  shell?: string;
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

  return ({ cols, rows }: PtySpawnOptions) =>
    new NodePtyProcess(
      spawn(shell, ["-NoLogo", "-NoProfile"], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: options.cwd,
        env: environment,
        useConpty: true,
        useConptyDll: true,
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
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
