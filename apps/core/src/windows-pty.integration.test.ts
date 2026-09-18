import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensurePowerShellIntegration } from "./shell-integration.js";
import { TerminalSessionManager } from "./terminal-session.js";
import { createWindowsPtyFactory } from "./windows-pty.js";

const windowsIt = process.platform === "win32" ? it : it.skip;

describe("Windows PowerShell PTY", () => {
  windowsIt(
    "keeps shell state across reconnect and handles Ctrl+C",
    async () => {
      const dataDirectory = mkdtempSync(join(tmpdir(), "stackbridge-shell-test-"));
      const manager = new TerminalSessionManager(
        createWindowsPtyFactory({
          cwd: process.cwd(),
          integrationPath: ensurePowerShellIntegration(dataDirectory),
        }),
      );
      const session = manager.create({ cols: 100, rows: 30 });
      let output = "";
      const detach = session.subscribe((event) => {
        if (event.type !== "output") return;
        output += event.data;
      });

      try {
        await waitForOutput(() => output, "PS ", 15_000);
        session.write('Write-Output "SB_TERM=$env:TERM SB_COLORTERM=$env:COLORTERM"\r');
        await waitForOutput(() => output, "SB_TERM=xterm-256color SB_COLORTERM=truecolor");
        session.write(
          "$env:STACKBRIDGE_PTY_TEST='kept'; Write-Output ('SB_'+'READY')\r",
        );
        await waitForOutput(() => output, "SB_READY");
        await delay(500);

        detach();
        const reconnected = manager.get(session.id);
        expect(reconnected).toBe(session);
        expect(reconnected?.snapshot().replay).toContain("SB_READY");

        const reconnectOutput: string[] = [];
        reconnected?.subscribe((event) => {
          if (event.type === "output") reconnectOutput.push(event.data);
        });
        reconnected?.write(
          'Write-Output "SB_STATE=$env:STACKBRIDGE_PTY_TEST"\r',
        );
        await waitForOutput(
          () =>
            `${reconnectOutput.join("")}\n[replay]${reconnected?.snapshot().replay ?? ""}`,
          "SB_STATE=kept",
        );
        await delay(500);

        reconnected?.resize(120, 35);
        expect(reconnected?.snapshot()).toMatchObject({ cols: 120, rows: 35 });
        reconnected?.write(
          "$v='栈桥🚀'; Write-Output ('UTF8='+$v)\r",
        );
        await waitForOutput(
          () => reconnectOutput.join(""),
          "UTF8=栈桥🚀",
        );
        await delay(500);

        reconnected?.write("Start-Sleep -Seconds 30\r");
        await delay(300);
        const beforeInterrupt = reconnectOutput.join("").length;
        reconnected?.write("\x03");
        await waitForOutput(
          () => reconnectOutput.join("").slice(beforeInterrupt),
          "PS ",
          5_000,
        );
        await delay(300);
        reconnected?.write("Write-Output ('SB_AFTER_'+'CTRL_C')\r");
        await waitForOutput(
          () => reconnectOutput.join(""),
          "SB_AFTER_CTRL_C",
          10_000,
        );
        await waitForCondition(() => (
          reconnected?.commands().some((command) =>
            command.command.includes("SB_AFTER_") && command.output.includes("SB_AFTER_CTRL_C"),
          ) === true && reconnected.context().shellState === "idle"
        ));
        expect(reconnected?.context()).toMatchObject({
          shellState: "idle",
          shell: "powershell",
        });
      } finally {
        manager.disposeAll();
        rmSync(dataDirectory, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

async function waitForOutput(
  read: () => string,
  marker: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!read().includes(marker)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${marker}. Output: ${read()}`);
    }
    await delay(25);
  }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await delay(25);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
