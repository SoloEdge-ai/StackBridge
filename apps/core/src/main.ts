import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  RemoteRuntimeManager,
  runtimeArtifactManifestSchema,
  type RuntimeArtifact,
} from "./remote-runtime-manager.js";
import { RemoteSessionManager } from "./remote-session-manager.js";
import { createCoreServer } from "./server.js";
import { TerminalSessionManager } from "./terminal-session.js";
import { createWindowsPtyFactory } from "./windows-pty.js";

if (process.platform !== "win32") {
  throw new Error("M0-A currently supports the Windows PowerShell PTY only.");
}

const host = "127.0.0.1";
const port = readPort(process.env.STACKBRIDGE_CORE_PORT, 7_331);
const launchToken =
  process.env.STACKBRIDGE_LAUNCH_TOKEN ?? randomBytes(24).toString("base64url");
const terminalCwd =
  process.env.STACKBRIDGE_TERMINAL_CWD ??
  process.env.INIT_CWD ??
  process.cwd();
const allowedOrigins = (
  process.env.STACKBRIDGE_ALLOWED_ORIGINS ??
  `http://127.0.0.1:5173,http://localhost:5173,http://${host}:${port}`
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const terminalSessions = new TerminalSessionManager(
  createWindowsPtyFactory({ cwd: terminalCwd }),
);
const repositoryRoot = process.env.INIT_CWD ?? process.cwd();
const runtimeManifestPath = resolve(
  process.env.STACKBRIDGE_RUNTIME_MANIFEST ?? resolve(repositoryRoot, "runtime", "bin", "manifest.json"),
);
const runtimeManifest = runtimeArtifactManifestSchema.parse(
  JSON.parse(readFileSync(runtimeManifestPath, "utf8")),
);
const runtimeArtifacts = runtimeManifest.artifacts.map((artifact) => ({
  path: resolve(
    process.env[`STACKBRIDGE_RUNTIME_ARTIFACT_${artifact.arch.toUpperCase()}`] ??
      resolve(runtimeManifestPath, "..", artifact.file),
  ),
  runtimeVersion: runtimeManifest.runtimeVersion,
  protocolVersion: runtimeManifest.protocolVersion,
  platform: artifact.platform,
  arch: artifact.arch,
  sha256: artifact.sha256,
} satisfies RuntimeArtifact));
const remoteSessions = new RemoteSessionManager(
  new RemoteRuntimeManager({ artifacts: runtimeArtifacts }),
);
const core = createCoreServer({
  launchToken,
  allowedOrigins,
  terminalSessions,
  remoteSessions,
});

await core.listen({ host, port });

console.log(`StackBridge Core listening on http://${host}:${port}`);
console.log(`Terminal working directory: ${terminalCwd}`);
console.log(`Bundled remote runtimes: ${runtimeArtifacts.map((item) => item.arch).join(", ") || "none"}`);
console.log(`Launch token: ${launchToken}`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await core.close();
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

function readPort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("STACKBRIDGE_CORE_PORT must be an integer from 1 to 65535.");
  }
  return parsed;
}
