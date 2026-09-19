import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test } from "@playwright/test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(testDirectory, "../../desktop");
const electronExecutable = resolve(
  desktopDirectory,
  "node_modules/electron/dist/electron.exe",
);
const sendF8Script = resolve(testDirectory, "fixtures/send-f8.ps1");

test("loads the desktop bridge and opens Quick Ask from a Windows F8 key", async () => {
  test.skip(process.platform !== "win32", "Windows keyboard integration test");
  const userDataDirectory = mkdtempSync(join(tmpdir(), "stackbridge-e2e-"));

  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [desktopDirectory],
    env: {
      ...process.env,
      STACKBRIDGE_USER_DATA_DIR: userDataDirectory,
    },
  });

  try {
    const page = await app.firstWindow();
    const terminalInput = page.locator(
      ".terminal-pane-shell.active .xterm-helper-textarea",
    );
    await terminalInput.waitFor({ state: "visible", timeout: 20_000 });

    await expect.poll(() => page.evaluate(() => typeof window.stackBridgeDesktop))
      .toBe("object");
    const windowHandle = await app.evaluate(({ BrowserWindow }) => {
      const handle = BrowserWindow.getAllWindows()[0]?.getNativeWindowHandle();
      if (!handle) throw new Error("Launched StackBridge window was not found");
      return handle.readBigUInt64LE().toString();
    });

    execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      sendF8Script,
      "-WindowHandle",
      windowHandle,
    ]);

    await expect(
      page.locator(".terminal-pane-shell.active .inline-assistant textarea"),
    ).toBeFocused();
  } finally {
    await app.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});
