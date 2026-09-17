import { randomBytes } from "node:crypto";

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
const core = createCoreServer({
  launchToken,
  allowedOrigins,
  terminalSessions,
});

await core.listen({ host, port });

console.log(`StackBridge Core listening on http://${host}:${port}`);
console.log(`Terminal working directory: ${terminalCwd}`);
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
