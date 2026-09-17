import { randomUUID } from "node:crypto";

import type {
  ServerTerminalMessage,
  TerminalSessionSnapshot,
} from "@stackbridge/protocol";

export interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
}

export type PtyFactory = (options: PtySpawnOptions) => PtyProcess;

export type TerminalSessionEvent = Extract<
  ServerTerminalMessage,
  { type: "output" | "exit" }
>;

type TerminalSessionListener = (event: TerminalSessionEvent) => void;

export interface TerminalSessionAttachment {
  snapshot: TerminalSessionSnapshot;
  detach: () => void;
}

export class TerminalSession {
  readonly id: string;

  private state: "running" | "exited" = "running";
  private replay = "";
  private exitCode: number | undefined;
  private signal: number | undefined;
  private readonly listeners = new Set<TerminalSessionListener>();
  private readonly unsubscribePty: Array<() => void>;

  constructor(
    private readonly pty: PtyProcess,
    private cols: number,
    private rows: number,
    private readonly replayBytes: number,
    id = randomUUID(),
  ) {
    this.id = id;
    this.unsubscribePty = [
      pty.onData((data) => this.receiveOutput(data)),
      pty.onExit((event) => this.receiveExit(event)),
    ];
  }

  snapshot(): TerminalSessionSnapshot {
    return {
      id: this.id,
      state: this.state,
      cols: this.cols,
      rows: this.rows,
      replay: this.replay,
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    };
  }

  subscribe(listener: TerminalSessionListener): () => void {
    return this.attach(listener).detach;
  }

  attach(listener: TerminalSessionListener): TerminalSessionAttachment {
    this.listeners.add(listener);
    return {
      snapshot: this.snapshot(),
      detach: () => {
        this.listeners.delete(listener);
      },
    };
  }

  write(data: string): void {
    this.ensureRunning();
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.ensureRunning();
    this.pty.resize(cols, rows);
    this.cols = cols;
    this.rows = rows;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribePty) unsubscribe();
    this.listeners.clear();
    if (this.state === "running") this.pty.kill();
  }

  private receiveOutput(data: string): void {
    this.replay = trimUtf8Start(`${this.replay}${data}`, this.replayBytes);
    this.publish({ type: "output", data });
  }

  private receiveExit(event: PtyExitEvent): void {
    this.state = "exited";
    this.exitCode = event.exitCode;
    this.signal = event.signal;
    this.publish({
      type: "exit",
      exitCode: event.exitCode,
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    });
  }

  private publish(event: TerminalSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private ensureRunning(): void {
    if (this.state === "exited") throw new Error("Terminal session has exited");
  }
}

export interface TerminalSessionManagerOptions {
  replayBytes?: number;
  maxSessions?: number;
}

export class TerminalSessionLimitError extends Error {
  constructor() {
    super("Terminal session limit reached");
  }
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly replayBytes: number;
  private readonly maxSessions: number;

  constructor(
    private readonly ptyFactory: PtyFactory,
    options: TerminalSessionManagerOptions = {},
  ) {
    this.replayBytes = options.replayBytes ?? 1_048_576;
    this.maxSessions = options.maxSessions ?? 16;
  }

  create(options: PtySpawnOptions): TerminalSession {
    this.makeRoom();
    const session = new TerminalSession(
      this.ptyFactory(options),
      options.cols,
      options.rows,
      this.replayBytes,
    );
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  private makeRoom(): void {
    if (this.sessions.size < this.maxSessions) return;
    for (const [id, session] of this.sessions) {
      if (session.snapshot().state !== "exited") continue;
      session.dispose();
      this.sessions.delete(id);
      return;
    }
    throw new TerminalSessionLimitError();
  }
}

function trimUtf8Start(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;

  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
