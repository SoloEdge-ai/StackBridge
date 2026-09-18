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
    const collectPaneIds = (layout: unknown): string[] => {
      if (!layout || typeof layout !== "object") return [];
      const item = layout as {
        type?: unknown;
        pane?: { id?: unknown };
        first?: unknown;
        second?: unknown;
      };
      if (item.type === "pane") return typeof item.pane?.id === "string" ? [item.pane.id] : [];
      if (item.type === "split") return [...collectPaneIds(item.first), ...collectPaneIds(item.second)];
      return [];
    };
    const ids = new Set<string>();
    for (const key of ["stackbridge.terminalTabs.v3", "stackbridge.terminalTabs.v2"]) {
      const stored = sessionStorage.getItem(key);
      const tabs = stored === null ? [] : JSON.parse(stored) as Array<{ id?: unknown; layout?: unknown }>;
      for (const tab of tabs) {
        for (const paneId of collectPaneIds(tab.layout)) ids.add(paneId);
        if (typeof tab.id === "string" && !tab.layout) ids.add(tab.id);
      }
      sessionStorage.removeItem(key);
    }
    for (const paneId of ids) {
      await fetch(`/v1/terminal-sessions/${paneId}`, { method: "DELETE" });
    }
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
  await expect(page.locator(".environment-bar")).toHaveCount(0);
  await expect(page.locator(".terminal-pane-context")).toContainText("本地 Windows");
  await expect(page.locator(".terminal-host .xterm")).toBeVisible();
  await expect(page.locator(".assistant-panel")).toBeVisible();
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText(
    "本地 Windows",
    { timeout: 10_000 },
  );

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

test("splits the active terminal horizontally from its context menu", async ({ page }) => {
  await page.goto("/");

  const panes = page.getByRole("group", { name: "终端窗格" });
  await expect(panes).toHaveCount(1);
  await panes.first().click({ button: "right" });

  const menu = page.getByRole("menu", { name: "终端分栏" });
  await expect(menu).toBeVisible();
  await page.getByRole("menuitem", { name: "横向分栏（左右排列）" }).click();
  await expect(panes).toHaveCount(2);

  const firstBox = await panes.nth(0).boundingBox();
  const secondBox = await panes.nth(1).boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(secondBox!.x).toBeGreaterThan(firstBox!.x + 20);
  expect(Math.abs(secondBox!.y - firstBox!.y)).toBeLessThan(5);

  const secondInput = panes.nth(1).locator(".xterm-helper-textarea");
  await secondInput.focus();
  await secondInput.pressSequentially("Write-Output 'SPLIT_RIGHT_OK'", { delay: 8 });
  await secondInput.press("Enter");
  await expect(panes.nth(1).locator(".xterm-rows")).toContainText(
    "SPLIT_RIGHT_OK",
    { timeout: 10_000 },
  );
  await page.screenshot({
    path: resolve(screenshotDirectory, "06-horizontal-terminal-split.png"),
    fullPage: true,
  });

  await page.reload();
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(1).locator(".xterm-rows")).toContainText("SPLIT_RIGHT_OK", { timeout: 10_000 });
  await panes.nth(0).locator(".xterm-helper-textarea").focus();
  await expect(panes.nth(0)).toHaveClass(/active/);
  await panes.nth(1).locator(".xterm-helper-textarea").focus();
  await expect(panes.nth(1)).toHaveClass(/active/);
  await panes.nth(1).getByRole("button", { name: "关闭 PowerShell 分栏" }).click();
  await expect(panes).toHaveCount(1);
});

test("splits the active terminal vertically from its context menu", async ({ page }) => {
  await page.goto("/");

  const panes = page.getByRole("group", { name: "终端窗格" });
  await expect(panes).toHaveCount(1);
  await panes.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "纵向分栏（上下排列）" }).click();
  await expect(panes).toHaveCount(2);

  const firstBox = await panes.nth(0).boundingBox();
  const secondBox = await panes.nth(1).boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(secondBox!.y).toBeGreaterThan(firstBox!.y + 20);
  expect(Math.abs(secondBox!.x - firstBox!.x)).toBeLessThan(5);
  await expect(panes.nth(1).locator(".xterm-rows")).toContainText("PS ", { timeout: 10_000 });
  await expect(page.locator(".terminal-pane-shell.active .environment-meta")).toContainText("powershell", { timeout: 10_000 });
  await page.screenshot({
    path: resolve(screenshotDirectory, "07-vertical-terminal-split.png"),
    fullPage: true,
  });
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
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).toContainText(
    "friden@friden-dev-cube",
    { timeout: 30_000 },
  );
  await expect(page.locator(".terminal-pane-shell.active .environment-main .warning-pill")).toHaveCount(0);
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
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).toContainText(
    "Docker: stackbridge-m0b1-ubuntu22",
    { timeout: 30_000 },
  );
  await expect(page.locator(".terminal-pane-shell.active .environment-main .warning-pill")).toHaveCount(0);
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

test("keeps verified SSH and Docker environment chains when splitting panes", async ({ page }) => {
  test.skip(process.env.STACKBRIDGE_E2E_REMOTE !== "1", "requires friden-dev-cube");
  test.setTimeout(90_000);
  await page.goto("/");

  await page.getByRole("button", { name: "新建连接" }).click();
  await page.locator(".connection-form").getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).toContainText(
    "friden@friden-dev-cube",
    { timeout: 30_000 },
  );
  const panes = page.getByRole("group", { name: "终端窗格" });
  await panes.first().click({ button: "right" });
  await expect(page.getByRole("menu", { name: "终端分栏" })).toContainText("同一 SSH 目标");
  await page.getByRole("menuitem", { name: "横向分栏（左右排列）" }).click();
  await expect(panes).toHaveCount(2);
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).toContainText(
    "friden@friden-dev-cube",
    { timeout: 30_000 },
  );
  await expect(panes.nth(0).locator(".xterm-rows")).toContainText("~", { timeout: 20_000 });
  await expect(panes.nth(1).locator(".xterm-rows")).toContainText("~", { timeout: 20_000 });
  for (let index = 0; index < 2; index += 1) {
    const input = panes.nth(index).locator(".xterm-helper-textarea");
    await input.focus();
    await input.pressSequentially(`printf 'SSH_SPLIT_${index}_OK\\n'`, { delay: 5 });
    await input.press("Enter");
  }
  await expect(panes.nth(0).locator(".xterm-rows")).toContainText("friden@friden-dev-cube", { timeout: 10_000 });
  await expect(panes.nth(1).locator(".xterm-rows")).toContainText("friden@friden-dev-cube", { timeout: 10_000 });
  await page.screenshot({
    path: resolve(screenshotDirectory, "08-ssh-terminal-split.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "新建连接" }).click();
  await page.getByRole("button", { name: "远端 Docker" }).click();
  await page.locator(".connection-form").getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).toContainText(
    "Docker: stackbridge-m0b1-ubuntu22",
    { timeout: 30_000 },
  );
  await panes.first().click({ button: "right" });
  await expect(page.getByRole("menu", { name: "终端分栏" })).toContainText("同一 Docker 目标");
  await page.getByRole("menuitem", { name: "纵向分栏（上下排列）" }).click();
  await expect(panes).toHaveCount(2);
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).toContainText(
    "Docker: stackbridge-m0b1-ubuntu22",
    { timeout: 30_000 },
  );
  await expect(panes.nth(0).locator(".xterm-rows")).toContainText("/workspace", { timeout: 20_000 });
  await expect(panes.nth(1).locator(".xterm-rows")).toContainText("/workspace", { timeout: 20_000 });
  for (let index = 0; index < 2; index += 1) {
    const input = panes.nth(index).locator(".xterm-helper-textarea");
    await input.focus();
    await input.pressSequentially(`printf 'DOCKER_SPLIT_${index}_OK\\n'`, { delay: 5 });
    await input.press("Enter");
  }
  await expect(panes.nth(0).locator(".xterm-rows")).toContainText("Docker: stackbridge-m0b1-ubuntu22", { timeout: 10_000 });
  await expect(panes.nth(1).locator(".xterm-rows")).toContainText("Docker: stackbridge-m0b1-ubuntu22", { timeout: 10_000 });
  await page.screenshot({
    path: resolve(screenshotDirectory, "09-docker-terminal-split.png"),
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
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).toContainText(
    "SSH: friden-dev-cube",
    { timeout: 20_000 },
  );
  await expect(page.locator(".terminal-pane-shell.active .environment-meta")).toContainText(
    "zsh",
    { timeout: 20_000 },
  );

  await terminalInput.pressSequentially(
    "docker exec -it stackbridge-m0b1-ubuntu22 bash",
    { delay: 8 },
  );
  await terminalInput.press("Enter");
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).toContainText(
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
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).not.toContainText(
    "Docker:",
    { timeout: 10_000 },
  );
  await expect(page.locator(".terminal-pane-shell.active .environment-meta")).toContainText("zsh");
});
