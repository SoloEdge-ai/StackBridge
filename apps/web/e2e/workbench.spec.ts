import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const screenshotDirectory = resolve(here, "../../../artifacts/playwright");

test.beforeAll(() => mkdirSync(screenshotDirectory, { recursive: true }));

test.afterEach(async ({ page }) => {
  if (!page.url().startsWith("http://127.0.0.1:5173")) return;
  await page.evaluate(async () => {
    const stored = sessionStorage.getItem("stackbridge.terminalTabs.v2");
    const tabs = stored === null ? [] : JSON.parse(stored) as Array<{ id?: unknown }>;
    for (const tab of tabs) {
      if (typeof tab.id === "string") {
        await fetch(`/v1/terminal-sessions/${tab.id}`, { method: "DELETE" });
      }
    }
    sessionStorage.removeItem("stackbridge.terminalTabs.v2");
  });
});

test("opens without a launch token and drives the real terminal workbench", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(".rail-brand")).toBeVisible();
  await expect(page.locator(".workspace-label")).toHaveCount(0);
  await expect(page.getByText("启动令牌")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建连接" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "AI 助手" })).toHaveCount(1);
  await expect(page.locator(".top-actions")).toHaveCount(0);
  await expect(page.locator(".terminal-host .xterm")).toBeVisible();
  await expect(page.locator(".assistant-panel")).toBeVisible();

  const terminalInput = page.locator(".terminal-host .xterm-helper-textarea");
  await terminalInput.focus();
  await terminalInput.pressSequentially("Write-Output 'PLAYWRIGHT_OK'", { delay: 12 });
  await terminalInput.press("Enter");
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText(
    "PLAYWRIGHT_OK",
    { timeout: 10_000 },
  );

  await page.screenshot({
    path: resolve(screenshotDirectory, "01-workbench-terminal-ai.png"),
    fullPage: true,
  });

  await page.keyboard.press("Control+Shift+Space");
  await expect(page.locator(".assistant-panel")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+Space");
  await expect(page.locator(".assistant-panel")).toBeVisible();
});

test("shows the managed SSH and Docker connection flow", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建连接" }).click();
  await expect(page.getByRole("heading", { name: "新建连接" })).toBeVisible();
  await expect(page.getByLabel("主机")).toHaveValue("friden-dev-cube");

  await page.getByRole("button", { name: "远端 Docker" }).click();
  await expect(page.getByLabel("容器名称或 ID")).toHaveValue(
    "stackbridge-m0b1-ubuntu22",
  );
  await expect(page.getByLabel("工作目录")).toHaveValue("/workspace");

  await page.screenshot({
    path: resolve(screenshotDirectory, "02-docker-connection.png"),
    fullPage: true,
  });
});

test("connects through the UI to verified SSH and Docker PTYs", async ({ page }) => {
  test.skip(process.env.STACKBRIDGE_E2E_REMOTE !== "1", "requires friden-dev-cube");
  test.setTimeout(60_000);
  await page.goto("/");

  await page.getByRole("button", { name: "新建连接" }).click();
  await page.locator(".connection-form").getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.locator(".environment-main")).toContainText(
    "friden@friden-dev-cube",
    { timeout: 30_000 },
  );
  await expect(page.locator(".environment-main .warning-pill")).toHaveCount(0);
  const sshInput = page.locator(".terminal-host .xterm-helper-textarea");
  await sshInput.focus();
  await sshInput.pressSequentially("printf 'PLAYWRIGHT_SSH_OK\\n'", { delay: 8 });
  await sshInput.press("Enter");
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText(
    "PLAYWRIGHT_SSH_OK",
    { timeout: 10_000 },
  );
  await page.screenshot({
    path: resolve(screenshotDirectory, "03-verified-ssh-terminal.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "新建连接" }).click();
  await page.getByRole("button", { name: "远端 Docker" }).click();
  await page.locator(".connection-form").getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.locator(".environment-main")).toContainText(
    "Docker: stackbridge-m0b1-ubuntu22",
    { timeout: 30_000 },
  );
  await expect(page.locator(".environment-main .warning-pill")).toHaveCount(0);
  const dockerInput = page.locator(".terminal-host .xterm-helper-textarea");
  await dockerInput.focus();
  await dockerInput.pressSequentially("printf 'PLAYWRIGHT_DOCKER_OK\\n'", { delay: 8 });
  await dockerInput.press("Enter");
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText(
    "PLAYWRIGHT_DOCKER_OK",
    { timeout: 10_000 },
  );
  await page.screenshot({
    path: resolve(screenshotDirectory, "04-verified-docker-terminal.png"),
    fullPage: true,
  });
});

test("tracks a hand-typed SSH session into an interactive Docker shell", async ({ page }) => {
  test.skip(process.env.STACKBRIDGE_E2E_REMOTE !== "1", "requires friden-dev-cube");
  test.setTimeout(60_000);
  await page.goto("/");

  const terminalInput = page.locator(".terminal-host .xterm-helper-textarea");
  await terminalInput.focus();
  await terminalInput.pressSequentially("ssh friden-dev-cube", { delay: 8 });
  await terminalInput.press("Enter");
  await expect(page.locator(".environment-main")).toContainText(
    "SSH: friden-dev-cube",
    { timeout: 20_000 },
  );
  await expect(page.locator(".environment-meta")).toContainText(
    "zsh",
    { timeout: 20_000 },
  );

  await terminalInput.pressSequentially(
    "docker exec -it stackbridge-m0b1-ubuntu22 bash",
    { delay: 8 },
  );
  await terminalInput.press("Enter");
  await expect(page.locator(".environment-main")).toContainText(
    "Docker: stackbridge-m0b1-ubuntu22",
    { timeout: 10_000 },
  );
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText(
    "/workspace#",
    { timeout: 10_000 },
  );
  await page.screenshot({
    path: resolve(screenshotDirectory, "05-manual-ssh-docker-detected.png"),
    fullPage: true,
  });

  await terminalInput.pressSequentially("exit", { delay: 8 });
  await terminalInput.press("Enter");
  await expect(page.locator(".environment-main")).not.toContainText(
    "Docker:",
    { timeout: 10_000 },
  );
  await expect(page.locator(".environment-meta")).toContainText("zsh");
});
