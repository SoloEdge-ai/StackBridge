import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sshConnectionProfileSchema,
  type ConnectionProfile,
  type DeploymentProposal,
} from "@stackbridge/protocol";
import { z } from "zod";

import {
  createPinnedHostFile,
  createSshRuntimeClient,
  managedRemoteRuntimePath,
  resolveKnownHost,
  runtimeSshSecurityArguments,
  type PinnedKnownHost,
  type RuntimeIdentity,
  type SshRuntimeClient,
} from "./ssh-runtime-client.js";

const processOutputLimit = 1_048_576;
const deploymentTimeoutMs = 120_000;

const runtimeVersionSchema = z.object({
  runtimeVersion: z.string().min(1),
  protocolVersion: z.literal(2),
  platform: z.literal("linux"),
  arch: z.enum(["amd64", "arm64"]),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

const installResultSchema = z.object({
  status: z.enum(["installed", "reused", "rolled_back"]),
  currentTarget: z.string().min(1),
  previousTarget: z.string().optional(),
  runtimeVersion: z.string().min(1),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

export const runtimeArtifactManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runtimeVersion: z.string().min(1),
  protocolVersion: z.literal(2),
  artifacts: z.array(z.object({
    platform: z.literal("linux"),
    arch: z.enum(["amd64", "arm64"]),
    file: z.string().min(1),
    sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict()).min(1),
}).strict();

export interface RuntimeArtifact {
  path: string;
  runtimeVersion: string;
  protocolVersion: 2;
  platform: "linux";
  arch: "amd64" | "arm64";
  sha256: string;
}

export interface RemoteProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RemoteProcessOptions {
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

export type RunRemoteProcess = (
  command: string,
  args: string[],
  options?: RemoteProcessOptions,
) => Promise<RemoteProcessResult>;

export interface RemoteRuntimeConnection {
  client: SshRuntimeClient;
  identity: RuntimeIdentity;
  hostKeyFingerprint: string;
  deployment: "reused" | "installed" | "upgraded";
}

interface RemoteRuntimeManagerOptions {
  artifacts: RuntimeArtifact[];
  run?: RunRemoteProcess;
  resolveKnownHost?: typeof resolveKnownHost;
  createClient?: typeof createSshRuntimeClient;
}

export class DeploymentApprovalRequiredError extends Error {
  constructor(readonly proposal: DeploymentProposal) {
    super("Remote runtime deployment requires approval");
    this.name = "DeploymentApprovalRequiredError";
  }
}

export class RemoteRuntimeManager {
  private readonly run: RunRemoteProcess;
  private readonly resolveHost: typeof resolveKnownHost;
  private readonly createClient: typeof createSshRuntimeClient;

  constructor(private readonly options: RemoteRuntimeManagerOptions) {
    this.run = options.run ?? runRemoteProcess;
    this.resolveHost = options.resolveKnownHost ?? resolveKnownHost;
    this.createClient = options.createClient ?? createSshRuntimeClient;
    for (const artifact of options.artifacts) this.verifyLocalArtifact(artifact);
  }

  async connect(
    inputProfile: unknown,
    options: { approvedProposal?: DeploymentProposal; signal?: AbortSignal },
  ): Promise<RemoteRuntimeConnection> {
    const profile = sshConnectionProfileSchema.parse(inputProfile);
    if (profile.kind !== "ssh") throw new Error("SSH profile is required");
    const knownHost = await this.resolveHost(
      profile.host,
      profile.port,
      profile.user,
      options.signal,
    );
    const pinnedHostFile = createPinnedHostFile(knownHost.knownHostsLine);
    let deployed = false;
    let upgraded = false;
    let installedTarget: string | undefined;
    let deploymentID: string | undefined;
    try {
      const platform = await this.probePlatform(profile, knownHost, pinnedHostFile.path, options.signal);
      const artifact = this.selectArtifact(platform.platform, platform.arch);
      this.verifyLocalArtifact(artifact);
      const current = await this.readRemoteVersion(profile, knownHost, pinnedHostFile.path, options.signal);
      const ready = current !== undefined &&
        current.runtimeVersion === artifact.runtimeVersion &&
        current.sha256 === artifact.sha256 &&
        current.protocolVersion === artifact.protocolVersion &&
        current.platform === artifact.platform &&
        current.arch === artifact.arch;

      if (!ready) {
        const reason: DeploymentProposal["reason"] = current === undefined
          ? "missing"
          : current.platform !== artifact.platform || current.arch !== artifact.arch
            ? "repair"
            : "upgrade";
        const proposal: DeploymentProposal = {
          reason,
          installRoot: "~/.sbridge",
          runtimeVersion: artifact.runtimeVersion,
          runtimeDigest: artifact.sha256,
          platform: artifact.platform,
          arch: artifact.arch,
          user: profile.user,
          host: profile.host,
          hostKeyFingerprint: knownHost.fingerprint,
          permissions: "0700 directories, 0755 runtime",
          cleanup: "Disconnect StackBridge, then remove ~/.sbridge",
        };
        if (
          options.approvedProposal === undefined ||
          JSON.stringify(options.approvedProposal) !== JSON.stringify(proposal)
        ) {
          throw new DeploymentApprovalRequiredError(proposal);
        }
        upgraded = current !== undefined;
        deploymentID = randomUUID();
        const result = await this.deploy(
          profile,
          knownHost,
          pinnedHostFile.path,
          artifact,
          deploymentID,
          options.signal,
        );
        deployed = true;
        installedTarget = result.currentTarget;
      }
    } finally {
      pinnedHostFile.cleanup();
    }

    let client: SshRuntimeClient | undefined;
    try {
      client = await this.createClient(profile, {
        resolveKnownHost: async () => knownHost,
        runtimePath: managedRemoteRuntimePath,
        signal: options.signal,
      });
      const identity = await client.handshake();
      const artifact = this.selectArtifact("linux", normalizeArch(identity.arch));
      if (identity.runtimeVersion !== artifact.runtimeVersion || identity.runtimeDigest !== artifact.sha256) {
        throw new Error("Remote runtime identity does not match the approved artifact");
      }
      return {
        client,
        identity,
        hostKeyFingerprint: knownHost.fingerprint,
        deployment: deployed ? (upgraded ? "upgraded" : "installed") : "reused",
      };
    } catch (error) {
      client?.close();
      if (deployed && installedTarget && deploymentID) {
        await this.rollback(profile, knownHost, installedTarget, deploymentID, options.signal).catch(
          (rollbackError: unknown) => {
            throw new AggregateError([error, rollbackError], "Runtime verification and rollback both failed");
          },
        );
      }
      throw error;
    }
  }

  private selectArtifact(platform: "linux", arch: "amd64" | "arm64"): RuntimeArtifact {
    const artifact = this.options.artifacts.find(
      (candidate) => candidate.platform === platform && candidate.arch === arch,
    );
    if (!artifact) throw new Error(`No bundled StackBridge runtime for ${platform}/${arch}`);
    return artifact;
  }

  private verifyLocalArtifact(artifact: RuntimeArtifact): void {
    const bytes = readFileSync(artifact.path);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== artifact.sha256) {
      throw new Error(`Bundled runtime digest mismatch for ${artifact.platform}/${artifact.arch}`);
    }
  }

  private async probePlatform(
    profile: Extract<ConnectionProfile, { kind: "ssh" }>,
    knownHost: PinnedKnownHost,
    knownHostsPath: string,
    signal?: AbortSignal,
  ): Promise<{ platform: "linux"; arch: "amd64" | "arm64" }> {
    const result = await this.run("ssh", [
      ...pinnedSshArguments(profile, knownHost, knownHostsPath),
      profile.host,
      "/usr/bin/uname",
      "-sm",
    ], { timeoutMs: 15_000, signal });
    if (result.exitCode !== 0) throw new Error(`Remote platform probe failed: ${result.stderr.trim()}`);
    const [system, machine] = result.stdout.trim().split(/\s+/);
    if (system !== "Linux") throw new Error(`Unsupported remote platform: ${system ?? "unknown"}`);
    return { platform: "linux", arch: normalizeArch(machine ?? "") };
  }

  private async readRemoteVersion(
    profile: Extract<ConnectionProfile, { kind: "ssh" }>,
    knownHost: PinnedKnownHost,
    knownHostsPath: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof runtimeVersionSchema> | undefined> {
    const result = await this.run("ssh", [
      ...pinnedSshArguments(profile, knownHost, knownHostsPath),
      profile.host,
      managedRemoteRuntimePath,
      "version",
    ], { timeoutMs: 15_000, signal });
    if (result.exitCode !== 0) return undefined;
    const parsed = runtimeVersionSchema.safeParse(parseJson(result.stdout));
    return parsed.success ? parsed.data : undefined;
  }

  private async deploy(
    profile: Extract<ConnectionProfile, { kind: "ssh" }>,
    knownHost: PinnedKnownHost,
    knownHostsPath: string,
    artifact: RuntimeArtifact,
    deploymentID: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof installResultSchema>> {
    await this.verifyRemoteUploadDirectories(
      profile,
      knownHost,
      knownHostsPath,
      signal,
    );
    const temporary = mkdtempSync(join(tmpdir(), "stackbridge-sftp-"));
    const batchPath = join(temporary, "upload.batch");
    const stagedPath = `.sbridge/staging/runtime-${deploymentID}.part`;
    const localPath = artifact.path.replaceAll("\\", "/").replaceAll('"', '\\"');
    writeFileSync(batchPath, [
      "-mkdir .sbridge",
      "chmod 700 .sbridge",
      "-mkdir .sbridge/staging",
      "chmod 700 .sbridge/staging",
      `put "${localPath}" ${stagedPath}`,
      `chmod 700 ${stagedPath}`,
      "",
    ].join("\n"), "utf8");
    try {
      const upload = await this.run("sftp", [
        "-b",
        batchPath,
        ...pinnedSftpArguments(profile, knownHost, knownHostsPath),
        profile.host,
      ], { timeoutMs: deploymentTimeoutMs, signal });
      if (upload.exitCode !== 0) throw new Error(`Runtime upload failed: ${upload.stderr.trim()}`);
      const manifest = {
        schemaVersion: 1,
        deploymentId: deploymentID,
        runtimeVersion: artifact.runtimeVersion,
        protocolVersion: artifact.protocolVersion,
        platform: artifact.platform,
        arch: artifact.arch,
        sha256: artifact.sha256,
      };
      const install = await this.run("ssh", [
        ...pinnedSshArguments(profile, knownHost, knownHostsPath),
        profile.host,
        stagedPath,
        "install",
      ], { input: `${JSON.stringify(manifest)}\n`, timeoutMs: deploymentTimeoutMs, signal });
      if (install.exitCode !== 0) throw new Error(`Runtime install failed: ${install.stderr.trim()}`);
      return installResultSchema.parse(parseJson(install.stdout));
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  private async verifyRemoteUploadDirectories(
    profile: Extract<ConnectionProfile, { kind: "ssh" }>,
    knownHost: PinnedKnownHost,
    knownHostsPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const path of [".sbridge", ".sbridge/staging"]) {
      const result = await this.run("ssh", [
        ...pinnedSshArguments(profile, knownHost, knownHostsPath),
        profile.host,
        "/usr/bin/stat",
        "-c",
        "%F",
        "--",
        path,
      ], { timeoutMs: 15_000, signal });
      if (result.exitCode !== 0) continue;
      if (result.stdout.trim() !== "directory") {
        throw new Error(`Managed upload path is not a real directory: ${path}`);
      }
    }
  }

  private async rollback(
    profile: Extract<ConnectionProfile, { kind: "ssh" }>,
    knownHost: PinnedKnownHost,
    expectedCurrent: string,
    deploymentID: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const pinned = createPinnedHostFile(knownHost.knownHostsLine);
    try {
      const result = await this.run("ssh", [
        ...pinnedSshArguments(profile, knownHost, pinned.path),
        profile.host,
        managedRemoteRuntimePath,
        "rollback",
      ], {
        input: `${JSON.stringify({ schemaVersion: 1, deploymentId: deploymentID, expectedCurrent })}\n`,
        timeoutMs: deploymentTimeoutMs,
        signal,
      });
      if (result.exitCode !== 0) throw new Error(`Runtime rollback failed: ${result.stderr.trim()}`);
      installResultSchema.parse(parseJson(result.stdout));
    } finally {
      pinned.cleanup();
    }
  }
}

function pinnedSshArguments(
  profile: Extract<ConnectionProfile, { kind: "ssh" }>,
  knownHost: PinnedKnownHost,
  knownHostsPath: string,
): string[] {
  return [
    ...runtimeSshSecurityArguments(),
    ...pinnedOptions(profile, knownHost, knownHostsPath),
    "-p",
    String(profile.port),
    "-l",
    profile.user,
  ];
}

function pinnedSftpArguments(
  profile: Extract<ConnectionProfile, { kind: "ssh" }>,
  knownHost: PinnedKnownHost,
  knownHostsPath: string,
): string[] {
  return [
    ...runtimeSshSecurityArguments().filter((argument) => argument !== "-T"),
    ...pinnedOptions(profile, knownHost, knownHostsPath),
    "-P",
    String(profile.port),
    "-o",
    `User=${profile.user}`,
  ];
}

function pinnedOptions(
  _profile: Extract<ConnectionProfile, { kind: "ssh" }>,
  knownHost: PinnedKnownHost,
  knownHostsPath: string,
): string[] {
  return [
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    `GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-o",
    `HostKeyAlias=${knownHost.lookupName}`,
  ];
}

function normalizeArch(machine: string): "amd64" | "arm64" {
  if (machine === "x86_64" || machine === "amd64") return "amd64";
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  throw new Error(`Unsupported remote architecture: ${machine || "unknown"}`);
}

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Remote runtime returned no JSON");
  return JSON.parse(trimmed);
}

export function runRemoteProcess(
  command: string,
  args: string[],
  options: RemoteProcessOptions = {},
): Promise<RemoteProcessResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: processOutputLimit,
      timeout: options.timeoutMs,
      signal: options.signal,
    }, (error, stdout, stderr) => {
      const exitCode = typeof (error as NodeJS.ErrnoException | null)?.code === "number"
        ? (error as unknown as { code: number }).code
        : error === null
          ? 0
          : 1;
      resolve({ exitCode, stdout, stderr });
    });
    child.once("error", reject);
    child.stdin?.end(options.input);
  });
}
