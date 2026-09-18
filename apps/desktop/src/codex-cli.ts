import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface CodexLaunchDescriptor {
  command: string;
  argumentPrefix: string[];
  resolvedPath: string;
}

export interface CodexCommandProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type CodexCommandProbe = (
  launch: CodexLaunchDescriptor,
  arguments_: string[],
) => Promise<CodexCommandProbeResult>;

export interface VerifiedCodexCli extends CodexLaunchDescriptor {
  version: string;
}

interface CodexResolutionOptions {
  platform?: NodeJS.Platform;
  path?: string;
  pathExt?: string;
  arch?: NodeJS.Architecture;
  isFile?(candidate: string): boolean;
}

interface ParsedCodexVersion {
  core: readonly [number, number, number];
  prerelease: string[] | undefined;
}

const minimumVersion = [0, 155, 0] as const;
const minimumVersionLabel = "0.155.0";
const commandTimeoutMs = 8_000;
const outputLimit = 8_192;

export function resolveCodexCli(
  options: CodexResolutionOptions = {},
): CodexLaunchDescriptor {
  return resolveCodexCliCandidates(options)[0]!;
}

export function resolveCodexCliCandidates(
  options: CodexResolutionOptions = {},
): CodexLaunchDescriptor[] {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return [{ command: "codex", argumentPrefix: [], resolvedPath: "codex" }];
  }

  const pathValue = options.path ?? process.env.PATH ?? "";
  const pathExtValue = options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const architecture = options.arch ?? process.arch;
  const isFile = options.isFile ?? ((candidate: string) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  const extensions = pathExtValue
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => [".com", ".exe", ".bat", ".cmd"].includes(value));

  const launches: CodexLaunchDescriptor[] = [];
  const resolvedPaths = new Set<string>();
  for (const directory of pathValue.split(";").map((value) => value.trim()).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(join(directory, `codex${extension}`));
      if (!isFile(candidate)) continue;
      const candidateKey = candidate.toLowerCase();
      if (resolvedPaths.has(candidateKey)) continue;
      resolvedPaths.add(candidateKey);
      if (extension === ".cmd" || extension === ".bat") {
        const nativeExecutable = npmShimNativeExecutables(candidate, architecture).find(isFile);
        if (nativeExecutable !== undefined) {
          launches.push({
            command: nativeExecutable,
            argumentPrefix: [],
            resolvedPath: nativeExecutable,
          });
        }
      } else {
        launches.push({ command: candidate, argumentPrefix: [], resolvedPath: candidate });
      }
    }
  }

  if (launches.length === 0) {
    throw new Error(
      "Codex CLI was not found in PATH. Install Codex CLI, make sure `codex --version` works in a new terminal, then reopen StackBridge.",
    );
  }
  return launches;
}

export async function requireCodexCli(
  launchOrCandidates: CodexLaunchDescriptor | readonly CodexLaunchDescriptor[],
  probe: CodexCommandProbe = probeCodexCommand,
): Promise<VerifiedCodexCli> {
  const candidates = Array.isArray(launchOrCandidates)
    ? launchOrCandidates
    : [launchOrCandidates];
  const verifiedVersions: Array<{
    launch: CodexLaunchDescriptor;
    version: string;
    parsedVersion: ParsedCodexVersion;
  }> = [];
  const failures: Error[] = [];

  for (const launch of candidates) {
    try {
      const versionResult = await runProbe(launch, ["--version"], "codex --version", probe);
      const version = versionResult.stdout.trim();
      const parsedVersion = parseCodexVersion(version);
      if (parsedVersion === undefined) {
        throw new Error(`codex --version returned unexpected output: ${version || "(empty)"}`);
      }
      if (compareCoreVersion(parsedVersion.core, minimumVersion) < 0) {
        throw new Error(
          `Codex CLI ${minimumVersionLabel} or newer is required; ${version} was found at ${launch.resolvedPath}.`,
        );
      }
      verifiedVersions.push({ launch, version, parsedVersion });
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  verifiedVersions.sort((left, right) => compareVersion(right.parsedVersion, left.parsedVersion));
  for (const candidate of verifiedVersions) {
    try {
      await runProbe(
        candidate.launch,
        ["app-server", "--help"],
        "codex app-server --help",
        probe,
      );
      return { ...candidate.launch, version: candidate.version };
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (candidates.length === 1 && failures[0] !== undefined) throw failures[0];
  const diagnostics = failures.map((failure) => failure.message).join("\n");
  throw new Error(
    `No compatible Codex CLI was found. Install Codex CLI ${minimumVersionLabel} or newer, make sure \`codex --version\` works in a new terminal, then reopen StackBridge.${diagnostics === "" ? "" : `\n\nDetails:\n${diagnostics}`}`,
  );
}

async function runProbe(
  launch: CodexLaunchDescriptor,
  arguments_: string[],
  label: string,
  probe: CodexCommandProbe,
): Promise<CodexCommandProbeResult> {
  let result: CodexCommandProbeResult;
  try {
    result = await probe(launch, arguments_);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Codex CLI was not found or could not be started. Install Codex CLI, make sure \`codex --version\` works in a new terminal, then reopen StackBridge.\n\nDetails: ${detail}`,
      { cause: error },
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no diagnostic output";
    throw new Error(`${label} failed (exit ${result.exitCode ?? "unknown"}): ${detail}`);
  }
  return result;
}

export async function probeCodexCommand(
  launch: CodexLaunchDescriptor,
  arguments_: string[],
): Promise<CodexCommandProbeResult> {
  return await new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(launch.command, [...launch.argumentPrefix, ...arguments_], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => rejectProbe(new Error(`Codex command timed out after ${commandTimeoutMs}ms`)));
    }, commandTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-outputLimit);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-outputLimit);
    });
    child.once("error", (error) => finish(() => rejectProbe(error)));
    child.once("exit", (exitCode) => finish(() => resolveProbe({ exitCode, stdout, stderr })));
  });
}

function npmShimNativeExecutables(
  shimPath: string,
  architecture: NodeJS.Architecture,
): string[] {
  const platformPackage = architecture === "arm64"
    ? "codex-win32-arm64"
    : "codex-win32-x64";
  const targetTriple = architecture === "arm64"
    ? "aarch64-pc-windows-msvc"
    : "x86_64-pc-windows-msvc";
  const packageRoot = join(dirname(shimPath), "node_modules", "@openai", "codex");
  const executableTail = ["vendor", targetTriple, "codex", "codex.exe"];
  return [
    resolve(join(packageRoot, ...executableTail)),
    resolve(join(packageRoot, "node_modules", "@openai", platformPackage, ...executableTail)),
  ];
}

function parseCodexVersion(value: string): ParsedCodexVersion | undefined {
  const match = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?(?:\+[0-9a-z.-]+)?$/i.exec(value);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split("."),
  };
}

function compareVersion(left: ParsedCodexVersion, right: ParsedCodexVersion): number {
  const coreDifference = compareCoreVersion(left.core, right.core);
  if (coreDifference !== 0) return coreDifference;
  if (left.prerelease === undefined) return right.prerelease === undefined ? 0 : 1;
  if (right.prerelease === undefined) return -1;
  const identifierCount = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) - Number(rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier.localeCompare(rightIdentifier);
  }
  return 0;
}

function compareCoreVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
