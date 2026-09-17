import { describe, expect, it } from "vitest";

import { TerminalSessionManager } from "./terminal-session.js";
import { createWindowsPtyFactory } from "./windows-pty.js";

const windowsIt = process.platform === "win32" ? it : it.skip;

describe("Windows PowerShell PTY", () => {
  windowsIt(
    "keeps shell state across reconnect and handles Ctrl+C",
    async () => {
      const manager = new TerminalSessionManager(
        createWindowsPtyFactory({ cwd: process.cwd() }),
      );
      const session = manager.create({ cols: 100, rows: 30 });
      let output = "";
      const detach = session.subscribe((event) => {
        if (event.type !== "output") return;
        output += event.data;
      });

      try {
        await waitForOutput(() => output, "PS ");
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
      } finally {
        manager.disposeAll();
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
