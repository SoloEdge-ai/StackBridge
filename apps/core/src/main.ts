import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CodexAppServer, defaultCodexDirectories } from "./codex-app-server.js";
import { ConversationService } from "./conversation-service.js";
import {
  RemoteRuntimeManager,
  runtimeArtifactManifestSchema,
  type RuntimeArtifact,
} from "./remote-runtime-manager.js";
import { RemoteSessionManager } from "./remote-session-manager.js";
import { createRemotePtyLauncher } from "./remote-pty.js";
import { createCoreServer } from "./server.js";
import { ensurePowerShellIntegration } from "./shell-integration.js";
import { TerminalSessionManager } from "./terminal-session.js";
import { createWindowsPtyFactory } from "./windows-pty.js";
import { WorkspaceStore } from "./workspace-store.js";

if (process.platform !== "win32") {
  throw new Error("M0-A currently supports the Windows PowerShell PTY only.");
}

const host = "127.0.0.1";
const port = readPort(process.env.STACKBRIDGE_CORE_PORT, 7_331);
const terminalCwd =
  process.env.STACKBRIDGE_TERMINAL_CWD ??
  process.env.INIT_CWD ??
  process.cwd();
const dataDirectory = resolveDataDirectory();
mkdirSync(dataDirectory, { recursive: true });
const powerShellIntegration = ensurePowerShellIntegration(dataDirectory);
const workspaceStore = new WorkspaceStore(dataDirectory);
const allowedOrigins = (
  process.env.STACKBRIDGE_ALLOWED_ORIGINS ??
  `http://127.0.0.1:5173,http://localhost:5173,http://${host}:${port}`
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const terminalSessions = new TerminalSessionManager(
  createWindowsPtyFactory({
    cwd: terminalCwd,
    integrationPath: powerShellIntegration,
  }),
  { onCommandCompleted: (command) => workspaceStore.recordCommand(command) },
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
const remotePtyLauncher = createRemotePtyLauncher(remoteSessions, terminalCwd);
const codexDirectories = defaultCodexDirectories(dataDirectory);
const ai = new CodexAppServer({
  ...codexDirectories,
  ...(process.env.STACKBRIDGE_CODEX_BIN === undefined
    ? {}
    : { command: process.env.STACKBRIDGE_CODEX_BIN }),
});
const conversations = new ConversationService(
  terminalSessions,
  ai,
  () => new Date(),
  workspaceStore,
);
const core = createCoreServer({
  allowedOrigins,
  terminalSessions,
  ...(process.env.STACKBRIDGE_WEB_DIST_DIR === undefined
    ? {}
    : { staticDirectory: resolve(process.env.STACKBRIDGE_WEB_DIST_DIR) }),
  remoteSessions,
  remotePtyLauncher,
  conversations,
  ai,
  settings: workspaceStore,
});

await core.listen({ host, port });

console.log(`StackBridge Core listening on http://${host}:${port}`);
console.log(`Terminal working directory: ${terminalCwd}`);
console.log(`StackBridge data directory: ${dataDirectory}`);
console.log(`Bundled remote runtimes: ${runtimeArtifacts.map((item) => item.arch).join(", ") || "none"}`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await core.close();
  } finally {
    workspaceStore.close();
  }
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

function resolveDataDirectory(): string {
  const configured = process.env.STACKBRIDGE_DATA_DIR;
  if (configured !== undefined && configured.trim() !== "") return resolve(configured);
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.trim() === "") {
    throw new Error("LOCALAPPDATA is required unless STACKBRIDGE_DATA_DIR is set");
  }
  return resolve(localAppData, "StackBridge");
}
