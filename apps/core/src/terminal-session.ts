import { randomBytes, randomUUID } from "node:crypto";

import type {
  ServerTerminalMessage,
  TerminalSessionSnapshot,
} from "@stackbridge/protocol";

import { localEnvironmentLabel } from "./environment-labels.js";
import { dockerShellIntegrationToken } from "./shell-integration-token.js";

const terminalClearSequence = "\u001b[H\u001b[2J\u001b[3J";

function isTerminalClearCommand(command: string): boolean {
  const normalized = command.trim().replace(/^command\s+/, "");
  return normalized === "clear" || normalized === "cls";
}

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
  shellIntegrationToken?: string;
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

export type ShellState = "idle" | "running" | "foreground" | "unknown";

export interface TerminalEnvironment {
  id: string;
  parentId?: string;
  kind: "local" | "ssh" | "docker";
  label: string;
  verified: boolean;
  bindingId?: string;
  host?: string;
  containerId?: string;
}

export interface TerminalContext {
  terminalSessionId: string;
  contextVersion: number;
  shellState: ShellState;
  inputVersion: number;
  inputEmpty: boolean;
  cwd: string;
  shell: string;
  user: string;
  outputSequence: number;
  environment: TerminalEnvironment;
  environmentStack: TerminalEnvironment[];
  recentCommandIds: string[];
}

export interface CommandBlock {
  id: string;
  terminalSessionId: string;
  environmentFrameId: string;
  bindingId?: string;
  source: "manual" | "ai";
  operationId?: string;
  command: string;
  cwdBefore: string;
  cwdAfter: string;
  shell: string;
  user: string;
  startedAt: string;
  endedAt: string;
  exitCode?: number;
  outputStartSequence: number;
  outputEndSequence: number;
  output: string;
  outputTruncated: boolean;
  captureQuality: "exact" | "screen" | "unknown";
}

export interface ApprovedCommandRequest {
  operationId: string;
  command: string;
  terminalSessionId: string;
  environmentFrameId: string;
  bindingId: string | undefined;
  cwd: string;
  shell: string;
  contextVersion: number;
  inputVersion: number;
}

export interface ExecutionOperation {
  id: string;
  command: string;
  status:
    | "accepted"
    | "running"
    | "completed"
    | "failed"
    | "interrupted"
    | "unknown";
  createdAt: string;
  updatedAt: string;
  commandBlockId?: string;
  exitCode?: number;
}

export interface TerminalSessionInitialContext {
  environments: TerminalEnvironment[];
  cwd: string;
  shell: string;
  user: string;
  shellState?: ShellState;
  shellIntegrationToken?: string;
}

type ShellIntegrationEvent =
  | {
      type: "prompt";
      cwd: string;
      shell: string;
      user: string;
    }
  | {
      type: "commandStart";
      command: string;
      cwd: string;
      shell: string;
      user: string;
      source?: "manual" | "ai";
    }
  | { type: "commandEnd"; cwd: string; exitCode?: number }
  | {
      type: "environmentPush";
      kind: "ssh" | "docker";
      label: string;
      host?: string;
      containerId?: string;
      bindingId?: string;
      verified?: boolean;
    }
  | { type: "environmentPop" };

interface ActiveCommand {
  id: string;
  environment: TerminalEnvironment;
  source: "manual" | "ai";
  operationId?: string;
  command: string;
  cwdBefore: string;
  shell: string;
  user: string;
  startedAt: string;
  outputStartSequence: number;
  output: string;
  outputTruncated: boolean;
}

export class TerminalSession {
  readonly id: string;

  private state: "running" | "exited" = "running";
  private replay = "";
  private exitCode: number | undefined;
  private signal: number | undefined;
  private readonly listeners = new Set<TerminalSessionListener>();
  private readonly unsubscribePty: Array<() => void>;
  private readonly markerDecoder: ShellMarkerDecoder;
  private readonly commandBlocks: CommandBlock[] = [];
  private activeCommand: ActiveCommand | undefined;
  private pendingApproved:
    | { operationId: string; command: string }
    | undefined;
  private readonly operations = new Map<string, ExecutionOperation>();
  private interruptRequested = false;
  private readonly environments: TerminalEnvironment[];
  private contextVersion = 0;
  private shellState: ShellState = "unknown";
  private inputVersion = 0;
  private inputEmpty = true;
  private cwd = "";
  private shell = "";
  private user = "";
  private outputSequence = 0;

  constructor(
    private readonly pty: PtyProcess,
    private cols: number,
    private rows: number,
    private readonly replayBytes: number,
    id = randomUUID(),
    initialContext?: TerminalSessionInitialContext,
    private readonly onCommandCompleted?: (command: CommandBlock) => void,
    shellIntegrationToken?: string,
  ) {
    this.id = id;
    this.markerDecoder = new ShellMarkerDecoder(
      shellIntegrationToken ?? initialContext?.shellIntegrationToken ??
        randomBytes(24).toString("base64url"),
    );
    this.environments = initialContext?.environments.map((item) => ({ ...item })) ?? [
      {
        id: `env.${randomUUID()}`,
        kind: "local",
        label: localEnvironmentLabel,
        verified: true,
        bindingId: `local.${id}`,
      },
    ];
    if (this.environments.length === 0) {
      throw new Error("A terminal session needs at least one environment");
    }
    if (initialContext !== undefined) {
      this.cwd = initialContext.cwd;
      this.shell = initialContext.shell;
      this.user = initialContext.user;
      this.shellState = initialContext.shellState ?? "unknown";
    }
    this.unsubscribePty = [
      pty.onData((data) => this.receiveOutput(data)),
      pty.onExit((event) => this.receiveExit(event)),
    ];
  }

  context(): TerminalContext {
    const environment = this.environments.at(-1)!;
    return {
      terminalSessionId: this.id,
      contextVersion: this.contextVersion,
      shellState: this.shellState,
      inputVersion: this.inputVersion,
      inputEmpty: this.inputEmpty,
      cwd: this.cwd,
      shell: this.shell,
      user: this.user,
      outputSequence: this.outputSequence,
      environment: { ...environment },
      environmentStack: this.environments.map((item) => ({ ...item })),
      recentCommandIds: [
        ...this.commandBlocks.slice(-19).map((item) => item.id),
        ...(this.activeCommand === undefined ? [] : [this.activeCommand.id]),
      ],
    };
  }

  commands(): CommandBlock[] {
    return [
      ...this.commandBlocks.map((command) => ({ ...command })),
      ...(this.activeCommand === undefined
        ? []
        : [{
            id: this.activeCommand.id,
            terminalSessionId: this.id,
            environmentFrameId: this.activeCommand.environment.id,
            ...(this.activeCommand.environment.bindingId === undefined
              ? {}
              : { bindingId: this.activeCommand.environment.bindingId }),
            source: this.activeCommand.source,
            ...(this.activeCommand.operationId === undefined
              ? {}
              : { operationId: this.activeCommand.operationId }),
            command: this.activeCommand.command,
            cwdBefore: this.activeCommand.cwdBefore,
            cwdAfter: this.cwd,
            shell: this.activeCommand.shell,
            user: this.activeCommand.user,
            startedAt: this.activeCommand.startedAt,
            endedAt: new Date().toISOString(),
            outputStartSequence: this.activeCommand.outputStartSequence,
            outputEndSequence: this.outputSequence,
            output: this.activeCommand.output,
            outputTruncated: this.activeCommand.outputTruncated,
            captureQuality: "screen" as const,
          }]),
    ];
  }

  operation(id: string): ExecutionOperation | undefined {
    const operation = this.operations.get(id);
    return operation === undefined ? undefined : { ...operation };
  }

  validateApproved(request: ApprovedCommandRequest): void {
    this.ensureRunning();
    const context = this.context();
    if (
      request.terminalSessionId !== this.id ||
      request.environmentFrameId !== context.environment.id ||
      request.bindingId !== context.environment.bindingId ||
      request.cwd !== context.cwd ||
      request.shell !== context.shell ||
      request.contextVersion !== context.contextVersion ||
      request.inputVersion !== context.inputVersion
    ) {
      throw new Error("Terminal context changed; confirm the command again");
    }
    if (!context.environment.verified || context.environment.bindingId === undefined) {
      throw new Error("Terminal environment is not verified; automatic submission is disabled");
    }
    if (context.shellState !== "idle") {
      throw new Error("Terminal shell is not idle");
    }
    if (!context.inputEmpty) {
      throw new Error("Terminal input line is not empty");
    }
    if (request.command.trim() === "") throw new Error("Command is empty");
  }

  submitApproved(request: ApprovedCommandRequest): ExecutionOperation {
    const existing = this.operations.get(request.operationId);
    if (existing !== undefined) return { ...existing };
    this.validateApproved(request);

    const now = new Date().toISOString();
    const operation: ExecutionOperation = {
      id: request.operationId,
      command: request.command,
      status: "accepted",
      createdAt: now,
      updatedAt: now,
    };
    this.operations.set(operation.id, operation);
    this.pendingApproved = {
      operationId: operation.id,
      command: request.command,
    };
    this.shellState = "running";
    this.pty.write(`${request.command}\r`);
    return { ...operation };
  }

  insertCommand(command: string): void {
    this.ensureRunning();
    if (this.shellState !== "idle") throw new Error("Terminal shell is not idle");
    if (command === "") return;
    this.inputVersion += 1;
    this.inputEmpty = false;
    this.pty.write(command);
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
    this.inputVersion += 1;
    if (data.includes("\r") || data.includes("\n")) this.inputEmpty = true;
    else if (data === "\u0003" || data === "\u0015") this.inputEmpty = true;
    else if (data === "\u007f" || data === "\b") {
      // Without shell integration there is no reliable way to count graphemes.
      this.inputEmpty = false;
    } else if (!/^\u001b\[[A-Z~]$/.test(data)) this.inputEmpty = false;
    if (data === "\u0003" && this.activeCommand?.operationId !== undefined) {
      this.interruptRequested = true;
    }
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
    for (const item of this.markerDecoder.feed(data)) {
      if (item.kind === "event") this.receiveShellEvent(item.event);
      else this.receiveVisibleOutput(item.data);
    }
  }

  private receiveVisibleOutput(data: string): void {
    if (data === "") return;
    this.outputSequence += Buffer.byteLength(data, "utf8");
    this.replay = trimUtf8Start(`${this.replay}${data}`, this.replayBytes);
    if (this.activeCommand !== undefined) {
      const next = `${this.activeCommand.output}${data}`;
      const trimmed = trimUtf8Start(next, this.replayBytes);
      this.activeCommand.outputTruncated ||= trimmed !== next;
      this.activeCommand.output = trimmed;
    }
    this.publish({ type: "output", data });
  }

  private receiveShellEvent(event: ShellIntegrationEvent): void {
    this.contextVersion += 1;
    if (event.type === "prompt") {
      this.cwd = event.cwd;
      this.shell = event.shell;
      this.user = event.user;
      this.shellState = "idle";
      this.inputEmpty = true;
      return;
    }
    if (event.type === "commandStart") {
      // Some nested interactive shells consume `clear`'s control bytes before
      // they reach the parent PTY. Mirror the standard clear sequence at the
      // trusted command boundary so the visible terminal and replay agree.
      if (isTerminalClearCommand(event.command)) {
        this.receiveVisibleOutput(terminalClearSequence);
      }
      if (this.activeCommand !== undefined) {
        this.finishActiveCommand(this.cwd, undefined, "unknown");
      }
      this.cwd = event.cwd;
      this.shell = event.shell;
      this.user = event.user;
      this.shellState = "running";
      this.inputEmpty = true;
      const approved = this.pendingApproved?.command === event.command
        ? this.pendingApproved
        : undefined;
      if (this.pendingApproved !== undefined && approved === undefined) {
        this.updateOperation(this.pendingApproved.operationId, { status: "unknown" });
      }
      this.pendingApproved = undefined;
      if (approved !== undefined) {
        this.updateOperation(approved.operationId, { status: "running" });
      }
      this.activeCommand = {
        id: randomUUID(),
        environment: { ...this.environments.at(-1)! },
        source: approved === undefined ? event.source ?? "manual" : "ai",
        ...(approved === undefined ? {} : { operationId: approved.operationId }),
        command: event.command,
        cwdBefore: event.cwd,
        shell: event.shell,
        user: event.user,
        startedAt: new Date().toISOString(),
        outputStartSequence: this.outputSequence,
        output: "",
        outputTruncated: false,
      };
      return;
    }
    if (event.type === "commandEnd") {
      this.cwd = event.cwd;
      this.finishActiveCommand(event.cwd, event.exitCode, "exact");
      return;
    }
    if (event.type === "environmentPush") {
      this.environments.push({
        id: `env.${randomUUID()}`,
        parentId: this.environments.at(-1)!.id,
        kind: event.kind,
        label: event.label,
        // OSC output is display/context data only. It can never manufacture a
        // verified RuntimeBinding or participate in execution authority.
        verified: false,
        ...(event.host === undefined ? {} : { host: event.host }),
        ...(event.containerId === undefined
          ? {}
          : { containerId: event.containerId }),
      });
      return;
    }
    if (this.environments.length > 1) this.environments.pop();
  }

  private finishActiveCommand(
    cwdAfter: string,
    exitCode: number | undefined,
    captureQuality: CommandBlock["captureQuality"],
  ): void {
    const active = this.activeCommand;
    if (active === undefined) return;
    this.activeCommand = undefined;
    const commandBlock: CommandBlock = {
      id: active.id,
      terminalSessionId: this.id,
      environmentFrameId: active.environment.id,
      ...(active.environment.bindingId === undefined
        ? {}
        : { bindingId: active.environment.bindingId }),
      source: active.source,
      ...(active.operationId === undefined
        ? {}
        : { operationId: active.operationId }),
      command: active.command,
      cwdBefore: active.cwdBefore,
      cwdAfter,
      shell: active.shell,
      user: active.user,
      startedAt: active.startedAt,
      endedAt: new Date().toISOString(),
      ...(exitCode === undefined ? {} : { exitCode }),
      outputStartSequence: active.outputStartSequence,
      outputEndSequence: this.outputSequence,
      output: active.output,
      outputTruncated: active.outputTruncated,
      captureQuality,
    };
    this.commandBlocks.push(commandBlock);
    try {
      this.onCommandCompleted?.({ ...commandBlock });
    } catch {
      // Persistence failures must not destabilize the interactive terminal.
    }
    if (active.operationId !== undefined) {
      this.updateOperation(active.operationId, {
        status: this.interruptRequested
          ? "interrupted"
          : exitCode === 0
            ? "completed"
            : exitCode === undefined
              ? "unknown"
              : "failed",
        commandBlockId: commandBlock.id,
        ...(exitCode === undefined ? {} : { exitCode }),
      });
    }
    this.interruptRequested = false;
    if (this.commandBlocks.length > 200) this.commandBlocks.shift();
  }

  private updateOperation(
    id: string,
    update: Partial<Pick<ExecutionOperation, "status" | "commandBlockId" | "exitCode">>,
  ): void {
    const operation = this.operations.get(id);
    if (operation === undefined) return;
    Object.assign(operation, update, { updatedAt: new Date().toISOString() });
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

type DecodedShellItem =
  | { kind: "output"; data: string }
  | { kind: "event"; event: ShellIntegrationEvent };

const shellMarkerPrefix = "\u001b]777;stackbridge;";
const shellMarkerSuffix = "\u0007";

class ShellMarkerDecoder {
  private buffer = "";
  private readonly markers: Array<{
    prefix: string;
    allowEnvironmentEvents: boolean;
  }>;

  constructor(rootToken: string) {
    this.markers = [
      {
        prefix: `${shellMarkerPrefix}${rootToken};`,
        allowEnvironmentEvents: true,
      },
      {
        prefix: `${shellMarkerPrefix}${dockerShellIntegrationToken(rootToken)};`,
        allowEnvironmentEvents: false,
      },
    ];
  }

  feed(data: string): DecodedShellItem[] {
    this.buffer += data;
    const items: DecodedShellItem[] = [];
    while (this.buffer !== "") {
      const matches = this.markers
        .map((marker) => ({ marker, start: this.buffer.indexOf(marker.prefix) }))
        .filter((match) => match.start >= 0)
        .sort((left, right) => left.start - right.start);
      const match = matches[0];
      if (match === undefined) {
        const keep = Math.max(
          0,
          ...this.markers.map((marker) => longestMarkerPrefixSuffix(this.buffer, marker.prefix)),
        );
        const emit = this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        if (emit !== "") items.push({ kind: "output", data: emit });
        break;
      }
      const { prefix: authenticatedPrefix, allowEnvironmentEvents } = match.marker;
      const { start } = match;
      if (start > 0) {
        items.push({ kind: "output", data: this.buffer.slice(0, start) });
        this.buffer = this.buffer.slice(start);
      }
      const end = this.buffer.indexOf(shellMarkerSuffix, authenticatedPrefix.length);
      if (end < 0) break;
      const encoded = this.buffer.slice(authenticatedPrefix.length, end);
      this.buffer = this.buffer.slice(end + shellMarkerSuffix.length);
      const event = decodeShellEvent(encoded);
      const forbiddenEnvironmentEvent = event !== undefined &&
        !allowEnvironmentEvents &&
        (event.type === "environmentPush" || event.type === "environmentPop");
      if (event === undefined || forbiddenEnvironmentEvent) {
        items.push({
          kind: "output",
          data: `${authenticatedPrefix}${encoded}${shellMarkerSuffix}`,
        });
      } else items.push({ kind: "event", event });
    }
    return items;
  }
}

function longestMarkerPrefixSuffix(value: string, markerPrefix: string): number {
  const maximum = Math.min(value.length, markerPrefix.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (markerPrefix.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

function decodeShellEvent(encoded: string): ShellIntegrationEvent | undefined {
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (value.type === "prompt") {
      if (
        typeof value.cwd === "string" &&
        typeof value.shell === "string" &&
        typeof value.user === "string"
      ) return value as unknown as ShellIntegrationEvent;
    } else if (value.type === "commandStart") {
      if (
        typeof value.command === "string" &&
        typeof value.cwd === "string" &&
        typeof value.shell === "string" &&
        typeof value.user === "string" &&
        (value.source === undefined || value.source === "manual" || value.source === "ai")
      ) return value as unknown as ShellIntegrationEvent;
    } else if (value.type === "commandEnd") {
      if (
        typeof value.cwd === "string" &&
        (value.exitCode === undefined || Number.isInteger(value.exitCode))
      ) return value as unknown as ShellIntegrationEvent;
    } else if (value.type === "environmentPush") {
      if (
        (value.kind === "ssh" || value.kind === "docker") &&
        typeof value.label === "string"
      ) return value as unknown as ShellIntegrationEvent;
    } else if (value.type === "environmentPop") return { type: "environmentPop" };
  } catch {
    return undefined;
  }
  return undefined;
}

export interface TerminalSessionManagerOptions {
  replayBytes?: number;
  maxSessions?: number;
  onCommandCompleted?: (command: CommandBlock) => void;
  shellIntegrationTokenFactory?: () => string;
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
  private readonly onCommandCompleted: ((command: CommandBlock) => void) | undefined;
  private readonly shellIntegrationTokenFactory: () => string;

  constructor(
    private readonly ptyFactory: PtyFactory,
    options: TerminalSessionManagerOptions = {},
  ) {
    this.replayBytes = options.replayBytes ?? 1_048_576;
    this.maxSessions = options.maxSessions ?? 16;
    this.onCommandCompleted = options.onCommandCompleted;
    this.shellIntegrationTokenFactory = options.shellIntegrationTokenFactory ??
      (() => randomBytes(24).toString("base64url"));
  }

  create(options: PtySpawnOptions): TerminalSession {
    this.makeRoom();
    const authenticatedOptions = {
      ...options,
      shellIntegrationToken: this.shellIntegrationTokenFactory(),
    };
    return this.register(
      authenticatedOptions,
      this.ptyFactory(authenticatedOptions),
      undefined,
      authenticatedOptions.shellIntegrationToken,
    );
  }

  createFromPty(
    options: PtySpawnOptions,
    pty: PtyProcess,
    initialContext?: TerminalSessionInitialContext,
  ): TerminalSession {
    this.makeRoom();
    return this.register(
      options,
      pty,
      initialContext,
      initialContext?.shellIntegrationToken ?? this.shellIntegrationTokenFactory(),
    );
  }

  private register(
    options: PtySpawnOptions,
    pty: PtyProcess,
    initialContext?: TerminalSessionInitialContext,
    shellIntegrationToken?: string,
  ): TerminalSession {
    const session = new TerminalSession(
      pty,
      options.cols,
      options.rows,
      this.replayBytes,
      undefined,
      initialContext,
      this.onCommandCompleted,
      shellIntegrationToken,
    );
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    this.sessions.delete(id);
    session.dispose();
    return true;
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
