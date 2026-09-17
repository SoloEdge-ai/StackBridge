import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  runtimeCapabilitySchema,
  sshConnectionProfileSchema,
} from "@stackbridge/protocol";
import { z } from "zod";

export const m0B1RemoteRuntimePath =
  ".local/lib/stackbridge/runtime/m0-b1/stackbridge-runtime";

// The runtime caps stdout and stderr at 1 MiB each. JSON may encode every byte
// as a six-byte escape, so the transport limit must cover that worst case.
const maximumResponseLineBytes = 13 * 1_048_576;
const maximumRequestLineBytes = 1_048_575;
const defaultRequestTimeoutMs = 15_000;
const executionTransportGraceMs = 5_000;
const dockerPreflightBudgetMs = 75_000;

const runtimeIdentitySchema = z
  .object({
    protocolVersion: z.literal(1),
    runtimeInstanceId: z.string().min(1),
    hostBootId: z.string().min(1),
    principal: z
      .object({
        uid: z.number().int().nonnegative(),
        gid: z.number().int().nonnegative(),
        name: z.string().min(1).optional(),
      })
      .strict(),
    platform: z.literal("linux"),
    arch: z.string().min(1),
    defaultCwd: z.string().startsWith("/"),
    shell: z.string().startsWith("/"),
    capabilities: z.array(runtimeCapabilitySchema),
  })
  .strict();

const execResultSchema = z
  .object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.boolean(),
    stdoutTruncated: z.boolean().optional(),
    stderrTruncated: z.boolean().optional(),
  })
  .strict();

const dockerBindingEvidenceSchema = z
  .object({
    dockerDaemonId: z.string().min(1),
    containerId: z.string().regex(/^[0-9a-f]{64}$/),
    containerStartedAt: z.string().datetime({ offset: true }),
    containerInitStartTicks: z.string().regex(/^[1-9][0-9]*$/),
    containerState: z.literal("running"),
    principal: z
      .object({
        uid: z.number().int().nonnegative(),
        gid: z.number().int().nonnegative(),
        name: z.string().min(1).optional(),
      })
      .strict(),
    defaultCwd: z.string().startsWith("/"),
    shell: z.string().startsWith("/").nullable(),
    mountsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    capabilities: z.array(runtimeCapabilitySchema),
  })
  .strict();

const runtimeResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      version: z.literal(1),
      id: z.string(),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      id: z.string(),
      ok: z.literal(false),
      error: z
        .object({
          code: z.string().min(1),
          message: z.string(),
        })
        .strict(),
    })
    .strict(),
]);

export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;
export type RuntimeExecResult = z.infer<typeof execResultSchema>;
export type DockerBindingEvidence = z.infer<typeof dockerBindingEvidenceSchema>;
export interface RuntimeProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface RuntimeSpawnOptions {
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
}

export type SpawnRuntimeProcess = (
  command: string,
  args: string[],
  options: RuntimeSpawnOptions,
) => RuntimeProcess;

interface ClientOptions {
  spawn?: SpawnRuntimeProcess;
  requestTimeoutMs?: number;
  resolveKnownHost?: ResolveKnownHost;
  signal?: AbortSignal;
}

interface PinnedKnownHost {
  lookupName: string;
  knownHostsLine: string;
  fingerprint: string;
}

type ResolveKnownHost = (
  host: string,
  port: number,
  user: string,
  signal?: AbortSignal,
) => PinnedKnownHost | Promise<PinnedKnownHost>;

type RunOpenSshCommand = (
  command: string,
  args: string[],
  timeoutMs?: number,
  signal?: AbortSignal,
) => string | Promise<string>;

interface ExecRequest {
  cwd: string;
  program: string;
  args: string[];
  timeoutMs: number;
}

export interface DockerInspectRequest {
  contextName: string;
  selector: string;
  requestedUser: string;
  cwd: string;
}

export interface DockerExecRequest {
  contextName: string;
  dockerDaemonId: string;
  containerId: string;
  containerStartedAt: string;
  expectedContainerInitStartTicks: string;
  mountsDigest: string;
  user: string;
  expectedUid: number;
  expectedGid: number;
  cwd: string;
  program: string;
  args: string[];
  timeoutMs: number;
}

interface PendingRequest {
  schema: z.ZodType<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

interface HostKeyWaiter {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PinnedHostFile {
  path: string;
  cleanup: () => void;
}

export class RuntimeProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeProtocolError";
  }
}

export class SshRuntimeClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly hostKeyWaiters = new Set<HostKeyWaiter>();
  private dispatchTail: Promise<void> = Promise.resolve();
  private stdoutBuffer = "";
  private stderrTail = "";
  private hostKeyFingerprint: string | undefined;
  private closed = false;

  constructor(
    private readonly child: RuntimeProcess,
    private readonly requestTimeoutMs: number,
    private readonly expectedHostKeyFingerprint: string,
    private readonly pinnedHostFile: PinnedHostFile,
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => this.handleStdout(data));
    child.stderr.on("data", (data: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${data.toString()}`.slice(-16_384);
    });
    child.once("error", (error) => {
      this.markClosed(error);
      this.pinnedHostFile.cleanup();
    });
    child.once("exit", (code, signal) => {
      if (!this.closed) {
        const detail = this.stderrTail.trim();
        this.markClosed(
          new Error(
            `SSH runtime exited (code=${String(code)}, signal=${String(signal)})${detail ? `: ${detail}` : ""}`,
          ),
        );
      }
      this.pinnedHostFile.cleanup();
    });
  }

  handshake(): Promise<RuntimeIdentity> {
    return this.request("handshake", {}, runtimeIdentitySchema);
  }

  execute(request: ExecRequest): Promise<RuntimeExecResult> {
    return this.request(
      "exec",
      request,
      execResultSchema,
      this.executionDeadline(request.timeoutMs),
    );
  }

  inspectDocker(request: DockerInspectRequest): Promise<DockerBindingEvidence> {
    return this.request(
      "docker.inspect",
      request,
      dockerBindingEvidenceSchema,
      Math.max(this.requestTimeoutMs, dockerPreflightBudgetMs),
    );
  }

  executeDocker(request: DockerExecRequest): Promise<RuntimeExecResult> {
    return this.request(
      "docker.exec",
      request,
      execResultSchema,
      this.executionDeadline(request.timeoutMs, dockerPreflightBudgetMs),
    );
  }

  verifiedHostKey(): Promise<string> {
    if (this.hostKeyFingerprint !== undefined) {
      return Promise.resolve(this.hostKeyFingerprint);
    }
    if (this.closed) return Promise.reject(new Error("SSH runtime client is closed"));

    return new Promise<string>((resolve, reject) => {
      const waiter: HostKeyWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.hostKeyWaiters.delete(waiter);
          reject(new Error("SSH host key fingerprint was not reported"));
        }, this.requestTimeoutMs),
      };
      this.hostKeyWaiters.add(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill();
    this.failAll(new Error("SSH runtime client closed"));
    this.pinnedHostFile.cleanup();
  }

  private request<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    deadlineMs = this.requestTimeoutMs,
  ): Promise<T> {
    const dispatched = this.dispatchTail.then(() =>
      this.dispatchRequest(method, params, schema, deadlineMs),
    );
    this.dispatchTail = dispatched.then(
      () => undefined,
      () => undefined,
    );
    return dispatched;
  }

  private dispatchRequest<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    deadlineMs: number,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("SSH runtime client is closed"));

    const id = randomUUID();
    const payload = `${JSON.stringify({ version: 1, id, method, params })}\n`;
    if (Buffer.byteLength(payload, "utf8") > maximumRequestLineBytes) {
      return Promise.reject(
        new RuntimeProtocolError(
          "request_too_large",
          "SSH runtime request exceeded the size limit",
        ),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SSH runtime request timed out: ${method}`));
        this.close();
      }, deadlineMs);
      this.pending.set(id, {
        schema,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      this.child.stdin.write(payload, (error) => {
        if (error) this.rejectPending(id, error);
      });
    });
  }

  private executionDeadline(timeoutMs: number, preflightMs = 0): number {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return this.requestTimeoutMs;
    }
    return Math.max(
      this.requestTimeoutMs,
      timeoutMs + preflightMs + executionTransportGraceMs,
    );
  }

  private handleStdout(data: string): void {
    this.stdoutBuffer += data;
    for (let newline = this.stdoutBuffer.indexOf("\n"); newline >= 0; ) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > maximumResponseLineBytes) {
        this.abort(new Error("SSH runtime response exceeded the size limit"));
        return;
      }
      if (line.trim() !== "") this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > maximumResponseLineBytes) {
      this.abort(new Error("SSH runtime response exceeded the size limit"));
    }
  }

  private handleLine(line: string): void {
    let response: z.infer<typeof runtimeResponseSchema>;
    try {
      response = runtimeResponseSchema.parse(JSON.parse(line));
    } catch (error) {
      this.abort(new Error("SSH runtime returned an invalid response", { cause: error }));
      return;
    }

    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);

    if (!response.ok) {
      pending.reject(new RuntimeProtocolError(response.error.code, response.error.message));
      return;
    }
    try {
      const result = pending.schema.parse(response.result);
      if (this.hostKeyFingerprint === undefined) {
        this.resolveHostKey(this.expectedHostKeyFingerprint);
      }
      pending.resolve(result);
    } catch (error) {
      const message = "SSH runtime result did not match the contract";
      pending.reject(new Error(message, { cause: error }));
      this.abort(new Error(message, { cause: error }));
    }
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private failAll(error: Error): void {
    for (const [id] of this.pending) this.rejectPending(id, error);
    for (const waiter of this.hostKeyWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.hostKeyWaiters.clear();
  }

  private markClosed(error: Error): void {
    this.closed = true;
    this.failAll(error);
  }

  private abort(error: Error): void {
    this.markClosed(error);
    this.child.kill();
    this.pinnedHostFile.cleanup();
  }

  private resolveHostKey(fingerprint: string): void {
    this.hostKeyFingerprint = fingerprint;
    for (const waiter of this.hostKeyWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(fingerprint);
    }
    this.hostKeyWaiters.clear();
  }
}

export async function createSshRuntimeClient(
  inputProfile: unknown,
  options: ClientOptions = {},
): Promise<SshRuntimeClient> {
  const profile = sshConnectionProfileSchema.parse(inputProfile);
  assertSafeSshToken(profile.host, "host");
  assertSafeSshToken(profile.user, "user");
  if (profile.proxyJumpProfileIds.length > 0) {
    throw new Error("ProxyJump profiles are not supported by the M0-B1 runtime client");
  }

  const spawnRuntime = options.spawn ?? spawn;
  const knownHost = await (options.resolveKnownHost ?? resolveKnownHost)(
    profile.host,
    profile.port,
    profile.user,
    options.signal,
  );
  options.signal?.throwIfAborted();
  assertSafeSshOptionValue(knownHost.lookupName, "host-key lookup name");
  const pinnedHostFile = createPinnedHostFile(knownHost.knownHostsLine);
  const nullKnownHostsFile = process.platform === "win32" ? "NUL" : "/dev/null";
  const args = [
    ...runtimeSshSecurityArguments(),
    "-o",
    `UserKnownHostsFile=${pinnedHostFile.path}`,
    "-o",
    `GlobalKnownHostsFile=${nullKnownHostsFile}`,
    "-o",
    `HostKeyAlias=${knownHost.lookupName}`,
    "-p",
    String(profile.port),
    "-l",
    profile.user,
    profile.host,
    m0B1RemoteRuntimePath,
    "stdio",
  ];
  let child: RuntimeProcess;
  try {
    child = spawnRuntime("ssh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    pinnedHostFile.cleanup();
    throw error;
  }
  return new SshRuntimeClient(
    child,
    options.requestTimeoutMs ?? defaultRequestTimeoutMs,
    knownHost.fingerprint,
    pinnedHostFile,
  );
}

function createPinnedHostFile(knownHostsLine: string): PinnedHostFile {
  const directory = mkdtempSync(join(tmpdir(), "stackbridge-ssh-"));
  const path = join(directory, "known_hosts");
  writeFileSync(path, `${knownHostsLine}\n`, { encoding: "utf8", mode: 0o600 });
  let cleaned = false;
  return {
    path,
    cleanup: () => {
      if (cleaned) return;
      try {
        rmSync(directory, { recursive: true, force: true });
        cleaned = true;
      } catch {
        // The process exit callback retries if OpenSSH still has the file open.
      }
    },
  };
}

export async function resolveKnownHost(
  host: string,
  port: number,
  user: string,
  signal?: AbortSignal,
  runCommand: RunOpenSshCommand = runOpenSshCommand,
): Promise<PinnedKnownHost> {
  const config = await runCommand(
    "ssh",
    ["-T", "-G", "-p", String(port), "-l", user, host],
    undefined,
    signal,
  );
  const values = new Map<string, string>();
  for (const line of config.split(/\r?\n/)) {
    const separator = line.indexOf(" ");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const hostname = values.get("hostname");
  const effectivePort = Number(values.get("port"));
  if (!hostname || !Number.isSafeInteger(effectivePort) || effectivePort < 1) {
    throw new Error("OpenSSH did not resolve a valid host identity");
  }
  const configuredAlias = values.get("hostkeyalias");
  const lookupName = configuredAlias && configuredAlias !== "none" ? configuredAlias : hostname;
  assertSafeSshOptionValue(lookupName, "host-key lookup name");
  const query = effectivePort === 22 ? lookupName : `[${lookupName}]:${effectivePort}`;

  const directory = mkdtempSync(join(tmpdir(), "stackbridge-ssh-probe-"));
  const logPath = join(directory, "openssh.log");
  let authenticatedHostKey: AuthenticatedHostKey | undefined;
  try {
    await runCommand(
      "ssh",
      [
        "-v",
        "-E",
        logPath,
        ...runtimeSshSecurityArguments(),
        "-o",
        `HostKeyAlias=${lookupName}`,
        "-p",
        String(port),
        "-l",
        user,
        host,
        m0B1RemoteRuntimePath,
        "stdio",
      ],
      defaultRequestTimeoutMs,
      signal,
    );
    authenticatedHostKey = parseAuthenticatedHostKey(readFileSync(logPath, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (!authenticatedHostKey) {
    throw new Error("OpenSSH did not report an authenticated trusted host key");
  }
  const sourcePath =
    process.platform === "win32"
      ? authenticatedHostKey.sourcePath.replace(/\\\\/g, "\\")
      : authenticatedHostKey.sourcePath;
  const trustedLine = readFileSync(sourcePath, "utf8")
    .split(/\r?\n/)
    .at(authenticatedHostKey.sourceLine - 1)
    ?.trim();
  if (!trustedLine || trustedLine.startsWith("@")) {
    throw new Error("Certificate-authority host keys are not supported by M0-B1 pinning");
  }
  const selected = trustedLine.split(/\s+/);
  if (
    selected.length < 3 ||
    fingerprintForPublicKey(selected[2]!) !== authenticatedHostKey.fingerprint
  ) {
    throw new Error("The authenticated OpenSSH host key could not be pinned");
  }
  return {
    lookupName,
    knownHostsLine: `${query} ${selected[1]} ${selected[2]}`,
    fingerprint: authenticatedHostKey.fingerprint,
  };
}

function runtimeSshSecurityArguments(): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "FingerprintHash=sha256",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ProxyJump=none",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "KnownHostsCommand=none",
    "-o",
    "VerifyHostKeyDNS=no",
    "-o",
    "CheckHostIP=no",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "NoHostAuthenticationForLocalhost=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "RemoteCommand=none",
    "-o",
    "RequestTTY=no",
  ];
}

interface AuthenticatedHostKey {
  fingerprint: string;
  sourcePath: string;
  sourceLine: number;
}

function parseAuthenticatedHostKey(log: string): AuthenticatedHostKey | undefined {
  let candidate: string | undefined;
  let candidateIsKnown = false;
  let sourcePath: string | undefined;
  let sourceLine: number | undefined;
  for (const line of log.split(/\r?\n/)) {
    const keyMatch = line.match(
      /^debug1: Server host key:\s+\S+\s+(SHA256:[A-Za-z0-9+/]+={0,2})$/,
    );
    if (keyMatch?.[1]) {
      candidate = keyMatch[1];
      candidateIsKnown = false;
      sourcePath = undefined;
      sourceLine = undefined;
    } else if (/^debug1: Host '.+' is known and matches the .+ host key\.$/.test(line)) {
      candidateIsKnown = true;
    } else {
      const sourceMatch = line.match(/^debug1: Found key in (.+):([1-9][0-9]*)$/);
      if (sourceMatch?.[1] && sourceMatch[2] && candidateIsKnown) {
        sourcePath = sourceMatch[1];
        sourceLine = Number(sourceMatch[2]);
        continue;
      }
      if (
        /^Authenticated to .+ using ".+"\.$/.test(line) &&
        candidateIsKnown &&
        candidate &&
        sourcePath &&
        sourceLine
      ) {
        return { fingerprint: candidate, sourcePath, sourceLine };
      }
    }
  }
  return undefined;
}

function fingerprintForPublicKey(encodedKey: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey)) return undefined;
  const key = Buffer.from(encodedKey, "base64");
  if (key.length === 0) return undefined;
  const digest = createHash("sha256").update(key).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

function runOpenSshCommand(
  command: string,
  args: string[],
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1_048_576,
      timeout: timeoutMs,
      signal,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
    child.stdin?.end();
  });
}

function assertSafeSshToken(value: string, field: "host" | "user"): void {
  if (value.startsWith("-") || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error(`SSH ${field} is not safe for argv transport`);
  }
}

function assertSafeSshOptionValue(value: string, field: string): void {
  if (value === "" || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`SSH ${field} is not safe for option transport`);
  }
}
