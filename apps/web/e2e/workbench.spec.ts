import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const screenshotDirectory = resolve(here, "../../../artifacts/playwright");
const workbenchUrl = process.env.STACKBRIDGE_WEB_URL ?? "http://127.0.0.1:5173";

test.beforeAll(() => mkdirSync(screenshotDirectory, { recursive: true }));

test.afterEach(async ({ page }) => {
  if (!page.url().startsWith(workbenchUrl)) return;
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
    await fetch("/v1/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: "en" }),
    });
    localStorage.removeItem("stackbridge.locale");
  });
});

test("defaults to English and persists a Chinese language choice", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-brand")).toBeVisible();
  await page.evaluate(async () => {
    await fetch("/v1/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: "en" }),
    });
    localStorage.removeItem("stackbridge.locale");
  });
  await page.reload();

  await expect(page.getByRole("button", { name: "New connection" })).toBeVisible();
  await expect(page.getByRole("button", { name: "AI assistant" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建连接" })).toHaveCount(0);
  await expect(page.locator(".terminal-status")).toContainText("Connected to real PTY");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByLabel("Language").selectOption("zh-CN");

  await expect(page.getByRole("button", { name: "新建连接" })).toBeVisible();
  await expect(page.getByRole("button", { name: "AI 助手" })).toBeVisible();
  await expect(page.locator(".terminal-status")).toContainText("已连接真实 PTY");
  await expect.poll(() => page.evaluate(async () => {
    const response = await fetch("/v1/settings", { cache: "no-store" });
    if (!response.ok) return "unavailable";
    return ((await response.json()) as { locale?: string }).locale ?? "missing";
  })).toBe("zh-CN");

  await page.evaluate(() => localStorage.removeItem("stackbridge.locale"));
  await page.reload();
  await expect(page.getByRole("button", { name: "新建连接" })).toBeVisible();
  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByLabel("语言")).toHaveValue("zh-CN");
});

test("opens without a launch token and drives the real terminal workbench", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(".rail-brand")).toBeVisible();
  await expect(page.locator(".workspace-label")).toHaveCount(0);
  await expect(page.getByText("Launch token")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New connection" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "AI assistant" })).toHaveCount(1);
  await expect(page.locator(".top-actions")).toHaveCount(0);
  await expect(page.locator(".environment-bar")).toHaveCount(0);
  await expect(page.locator(".terminal-pane-context")).toContainText("Local Windows");
  await expect(page.locator(".terminal-host .xterm")).toBeVisible();
  await expect(page.locator(".assistant-panel")).toHaveCount(0);
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText(
    "Local Windows",
    { timeout: 10_000 },
  );
  const modelSelect = page.locator(".assistant-tools select").first();
  if (await modelSelect.count()) {
    await expect(modelSelect).toHaveValue("gpt-5.6-luna");
    await expect(modelSelect.locator("option[value='gpt-5.6-sol']")).toHaveCount(1);
    await expect(modelSelect.locator("option[value='gpt-5.6-terra']")).toHaveCount(1);
    await expect(modelSelect.locator("option[value='gpt-5.6-luna']")).toHaveCount(1);
  }

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

  await terminalInput.focus();
  await terminalInput.pressSequentially(
    "1..8 | ForEach-Object { Write-Output \"FOLLOW_$($_)\"; Start-Sleep -Milliseconds 150 }",
    { delay: 2 },
  );
  await terminalInput.press("Enter");
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText("FOLLOW_1");
  await page.keyboard.press("Control+Shift+Space");
  const followingAssistant = page.locator(".terminal-pane-shell.active .inline-assistant");
  await expect(followingAssistant).toBeVisible();
  const followingStartBox = await followingAssistant.boundingBox();
  expect(followingStartBox).not.toBeNull();
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText("FOLLOW_8", { timeout: 10_000 });
  await expect.poll(async () => {
    const currentBox = await followingAssistant.boundingBox();
    return currentBox !== null && currentBox.y > followingStartBox!.y + 30;
  }).toBe(true);
  await page.keyboard.press("Escape");

  await terminalInput.focus();
  await terminalInput.pressSequentially("Write-Output 'BUFFER_", { delay: 8 });
  const terminalBoxBeforeQuickAsk = await page.locator(".terminal-pane-shell.active .terminal-host").boundingBox();
  const cursorBoxBeforeQuickAsk = await page.locator(".terminal-pane-shell.active .xterm-cursor").boundingBox();
  await page.keyboard.press("Control+Shift+Space");
  const inlineAssistant = page.locator(".terminal-pane-shell.active .inline-assistant");
  await expect(inlineAssistant).toBeVisible();
  await expect(page.locator(".assistant-panel")).toHaveCount(0);
  const terminalBoxWithQuickAsk = await page.locator(".terminal-pane-shell.active .terminal-host").boundingBox();
  const quickAskBox = await inlineAssistant.boundingBox();
  expect(terminalBoxBeforeQuickAsk).not.toBeNull();
  expect(terminalBoxWithQuickAsk).not.toBeNull();
  expect(cursorBoxBeforeQuickAsk).not.toBeNull();
  expect(quickAskBox).not.toBeNull();
  expect(Math.abs(terminalBoxWithQuickAsk!.height - terminalBoxBeforeQuickAsk!.height)).toBeLessThan(2);
  expect(quickAskBox!.height).toBeLessThan(90);
  const distanceToCursor = Math.min(
    Math.abs(quickAskBox!.y - (cursorBoxBeforeQuickAsk!.y + cursorBoxBeforeQuickAsk!.height)),
    Math.abs((quickAskBox!.y + quickAskBox!.height) - cursorBoxBeforeQuickAsk!.y),
  );
  expect(distanceToCursor).toBeLessThan(20);
  await expect(inlineAssistant.locator(".inline-context-strip")).toContainText("Local Windows");
  const quickAskInput = inlineAssistant.locator("textarea");
  const oneLineInputBox = await quickAskInput.boundingBox();
  await quickAskInput.fill("line one\nline two\nline three");
  const threeLineInputBox = await quickAskInput.boundingBox();
  expect(oneLineInputBox).not.toBeNull();
  expect(threeLineInputBox).not.toBeNull();
  expect(threeLineInputBox!.height).toBeGreaterThan(oneLineInputBox!.height + 20);
  expect(threeLineInputBox!.height).toBeLessThanOrEqual(76);
  await quickAskInput.fill("");
  await page.screenshot({
    path: resolve(screenshotDirectory, "08-inline-terminal-ai.png"),
    fullPage: true,
  });
  await page.keyboard.press("Control+Shift+Space");
  await expect(inlineAssistant).toHaveCount(0);
  await expect(terminalInput).toBeFocused();
  await terminalInput.pressSequentially("PRESERVED'", { delay: 8 });
  await terminalInput.press("Enter");
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText(
    "BUFFER_PRESERVED",
    { timeout: 10_000 },
  );

  await terminalInput.focus();
  await terminalInput.pressSequentially("1..80 | ForEach-Object { Write-Output $_ }; Write-Output 'SCROLL_END_80'", { delay: 2 });
  await terminalInput.press("Enter");
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText(
    "SCROLL_END_80",
    { timeout: 10_000 },
  );
  await expect.poll(async () => {
    const terminalBox = await page.locator(".terminal-pane-shell.active .terminal-host").boundingBox();
    const cursorBox = await page.locator(".terminal-pane-shell.active .xterm-cursor").boundingBox();
    return terminalBox !== null && cursorBox !== null
      && cursorBox.y > terminalBox.y + terminalBox.height - 80;
  }).toBe(true);
  const terminalBoxBeforeFlippedQuickAsk = await page.locator(".terminal-pane-shell.active .terminal-host").boundingBox();
  const cursorBoxBeforeFlippedQuickAsk = await page.locator(".terminal-pane-shell.active .xterm-cursor").boundingBox();
  await page.keyboard.press("Control+Shift+Space");
  await expect(inlineAssistant).toHaveAttribute("data-placement", "above");
  const terminalBoxWithFlippedQuickAsk = await page.locator(".terminal-pane-shell.active .terminal-host").boundingBox();
  const flippedQuickAskBox = await inlineAssistant.boundingBox();
  expect(terminalBoxBeforeFlippedQuickAsk).not.toBeNull();
  expect(cursorBoxBeforeFlippedQuickAsk).not.toBeNull();
  expect(terminalBoxWithFlippedQuickAsk).not.toBeNull();
  expect(flippedQuickAskBox).not.toBeNull();
  expect(Math.abs(terminalBoxWithFlippedQuickAsk!.height - terminalBoxBeforeFlippedQuickAsk!.height)).toBeLessThan(2);
  expect(Math.abs((flippedQuickAskBox!.y + flippedQuickAskBox!.height) - cursorBoxBeforeFlippedQuickAsk!.y)).toBeLessThan(20);
  await page.keyboard.press("Escape");
});

test("asks the real Codex account from the active terminal pane", async ({ page }) => {
  test.skip(process.env.STACKBRIDGE_E2E_AI !== "1", "requires an authenticated ChatGPT account");
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.locator(".terminal-pane-context")).toContainText("Local Windows");

  await page.keyboard.press("Control+Shift+Space");
  const inlineAssistant = page.locator(".terminal-pane-shell.active .inline-assistant");
  await expect(inlineAssistant).toBeVisible();
  const prompt = inlineAssistant.locator("textarea");
  await expect(prompt).toBeFocused();
  await prompt.fill("Reply with exactly STACKBRIDGE_INLINE_AI_OK and no other text. Do not propose a command.");
  await prompt.press("Enter");

  await expect(inlineAssistant.locator(".inline-ai-response")).toContainText(
    "STACKBRIDGE_INLINE_AI_OK",
    { timeout: 90_000 },
  );
  await page.screenshot({
    path: resolve(screenshotDirectory, "09-cursor-anchored-ai-response.png"),
    fullPage: true,
  });
  await expect(page.locator(".assistant-panel")).toHaveCount(0);
});

test("offers AI actions beside the latest terminal output", async ({ page }) => {
  await page.goto("/");
  const pane = page.getByRole("group", { name: "Terminal pane" });
  const terminalInput = pane.locator(".xterm-helper-textarea");
  await terminalInput.focus();
  await terminalInput.pressSequentially("Write-Output 'AI_CONTEXT_READY'", { delay: 8 });
  await terminalInput.press("Enter");
  await expect(pane.locator(".xterm-rows")).toContainText("AI_CONTEXT_READY", { timeout: 10_000 });

  await pane.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Terminal actions" });
  await expect(menu.getByRole("menuitem", { name: "Explain latest output" })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "Fix latest command" })).toBeEnabled();
});

test("splits the active terminal horizontally from its context menu", async ({ page }) => {
  await page.goto("/");

  const panes = page.getByRole("group", { name: "Terminal pane" });
  await expect(panes).toHaveCount(1);
  await panes.first().click({ button: "right" });

  const menu = page.getByRole("menu", { name: "Terminal actions" });
  await expect(menu).toBeVisible();
  await page.getByRole("menuitem", { name: "Split horizontally (side by side)" }).click();
  await expect(panes).toHaveCount(2);

  await panes.nth(0).locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+Shift+Space");
  await panes.nth(0).locator(".inline-assistant textarea").fill("FIRST_PANE_DRAFT");
  await page.keyboard.press("Escape");
  await panes.nth(1).locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+Shift+Space");
  await expect(panes.nth(1).locator(".inline-assistant textarea")).toHaveValue("");
  await panes.nth(1).locator(".inline-assistant textarea").fill("SECOND_PANE_DRAFT");
  await page.keyboard.press("Escape");
  await panes.nth(0).locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+Shift+Space");
  await expect(panes.nth(0).locator(".inline-assistant textarea")).toHaveValue("FIRST_PANE_DRAFT");
  await page.keyboard.press("Escape");

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
  await page.keyboard.press("Control+Shift+Space");
  await expect(panes.nth(1).locator(".inline-assistant")).toBeVisible();
  await expect(panes.nth(0).locator(".inline-assistant")).toHaveCount(0);
  await page.keyboard.press("Escape");
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
  await panes.nth(1).getByRole("button", { name: "Close PowerShell split" }).click();
  await expect(panes).toHaveCount(1);
});

test("splits the active terminal vertically from its context menu", async ({ page }) => {
  await page.goto("/");

  const panes = page.getByRole("group", { name: "Terminal pane" });
  await expect(panes).toHaveCount(1);
  await panes.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Split vertically (stacked)" }).click();
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
  await page.getByRole("button", { name: "New connection" }).click();
  await expect(page.getByRole("heading", { name: "New connection" })).toBeVisible();
  await expect(page.getByLabel("Host")).toHaveValue("friden-dev-cube");

  await page.getByRole("button", { name: "Remote Docker" }).click();
  await expect(page.getByLabel("Container name or ID")).toHaveValue(
    "stackbridge-m0b1-ubuntu22",
  );
  await expect(page.getByLabel("Working directory")).toHaveValue("/workspace");

  await page.screenshot({
    path: resolve(screenshotDirectory, "02-docker-connection.png"),
    fullPage: true,
  });
});

test("connects through the UI to verified SSH and Docker PTYs", async ({ page }) => {
  test.skip(process.env.STACKBRIDGE_E2E_REMOTE !== "1", "requires friden-dev-cube");
  test.setTimeout(90_000);
  await page.goto("/");

  await page.getByRole("button", { name: "New connection" }).click();
  await page.locator(".connection-form").getByRole("button", { name: "Connect", exact: true }).click();
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

  await sshInput.pressSequentially(
    "docker exec -it stackbridge-m0b1-ubuntu22 bash",
    { delay: 4 },
  );
  await sshInput.press("Enter");
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).toContainText(
    "Docker: stackbridge-m0b1-ubuntu22",
    { timeout: 10_000 },
  );
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText(
    "Local Windows → friden@friden-dev-cube → Docker: stackbridge-m0b1-ubuntu22",
    { timeout: 10_000 },
  );
  await sshInput.pressSequentially("printf 'MANAGED_SSH_DOCKER_OK\\n'", { delay: 4 });
  await sshInput.press("Enter");
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText(
    "MANAGED_SSH_DOCKER_OK",
    { timeout: 10_000 },
  );
  await sshInput.pressSequentially("exit", { delay: 4 });
  await sshInput.press("Enter");
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).not.toContainText(
    "Docker:",
    { timeout: 10_000 },
  );

  await page.getByRole("button", { name: "New connection" }).click();
  await page.getByRole("button", { name: "Remote Docker" }).click();
  await page.locator(".connection-form").getByRole("button", { name: "Connect", exact: true }).click();
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

  await page.getByRole("button", { name: "New connection" }).click();
  await page.locator(".connection-form").getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).toContainText(
    "friden@friden-dev-cube",
    { timeout: 30_000 },
  );
  const panes = page.getByRole("group", { name: "Terminal pane" });
  await panes.first().click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Terminal actions" })).toContainText("Same SSH target");
  await page.getByRole("menuitem", { name: "Split horizontally (side by side)" }).click();
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

  await page.getByRole("button", { name: "New connection" }).click();
  await page.getByRole("button", { name: "Remote Docker" }).click();
  await page.locator(".connection-form").getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).toContainText(
    "Docker: stackbridge-m0b1-ubuntu22",
    { timeout: 30_000 },
  );
  await panes.first().click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Terminal actions" })).toContainText("Same Docker target");
  await page.getByRole("menuitem", { name: "Split vertically (stacked)" }).click();
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
  test.setTimeout(90_000);
  const terminalOutputFrames: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const message = JSON.parse(payload) as { type?: unknown; data?: unknown };
        if (message.type === "output" && typeof message.data === "string") {
          terminalOutputFrames.push(message.data);
        }
      } catch {}
    });
  });
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
    "SB_RC_BEFORE=\"$(docker exec stackbridge-m0b1-ubuntu22 /bin/sh -c 'if [ -f \"$HOME/.bashrc\" ]; then sha256sum \"$HOME/.bashrc\" | cut -d\" \" -f1; else printf MISSING; fi')\"; printf 'SB_RC_BASELINE_READY\\n'",
    { delay: 2 },
  );
  await terminalInput.press("Enter");
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText(
    "SB_RC_BASELINE_READY",
    { timeout: 10_000 },
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
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText(
    "Local Windows → SSH: friden-dev-cube → Docker: stackbridge-m0b1-ubuntu22",
    { timeout: 10_000 },
  );
  const dockerBreadcrumb = "Local Windows → SSH: friden-dev-cube → Docker: stackbridge-m0b1-ubuntu22";
  const terminalRows = page.locator(".terminal-host .xterm-rows");
  const breadcrumbCount = async () => {
    const text = await terminalRows.textContent();
    return text === null ? 0 : text.split(dockerBreadcrumb).length - 1;
  };

  await terminalInput.pressSequentially("printf 'DOCKER_PROMPT_ONE\\n'", { delay: 4 });
  await terminalInput.press("Enter");
  await expect(terminalRows).toContainText("DOCKER_PROMPT_ONE", { timeout: 10_000 });
  await expect.poll(breadcrumbCount, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

  await terminalInput.pressSequentially("printf 'DOCKER_PROMPT_TWO\\n'", { delay: 4 });
  await terminalInput.press("Enter");
  await expect(terminalRows).toContainText("DOCKER_PROMPT_TWO", { timeout: 10_000 });
  await expect.poll(breadcrumbCount, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await expect.poll(async () => page.evaluate(async () => {
    const stored = sessionStorage.getItem("stackbridge.terminalTabs.v3");
    if (stored === null) return { count: 0, attributed: false };
    const tabs = JSON.parse(stored) as Array<{
      layout?: { pane?: { id?: string }; first?: unknown; second?: unknown };
    }>;
    const firstPaneId = (layout: unknown): string | undefined => {
      if (!layout || typeof layout !== "object") return undefined;
      const item = layout as {
        type?: unknown;
        pane?: { id?: unknown };
        first?: unknown;
        second?: unknown;
      };
      if (item.type === "pane" && typeof item.pane?.id === "string") return item.pane.id;
      return firstPaneId(item.first) ?? firstPaneId(item.second);
    };
    const sessionId = firstPaneId(tabs[0]?.layout);
    if (sessionId === undefined) return { count: 0, attributed: false };
    const [commandsResponse, contextResponse] = await Promise.all([
      fetch(`/v1/terminal-sessions/${sessionId}/commands?limit=100`, { cache: "no-store" }),
      fetch(`/v1/terminal-sessions/${sessionId}/context`, { cache: "no-store" }),
    ]);
    if (!commandsResponse.ok || !contextResponse.ok) return { count: 0, attributed: false };
    const commands = (await commandsResponse.json()) as {
      data: Array<{ command?: string; environmentFrameId?: string }>;
    };
    const context = (await contextResponse.json()) as { environment?: { id?: string } };
    const innerCommands = commands.data.filter((command) =>
      command.command?.includes("DOCKER_PROMPT_")
    );
    return {
      count: innerCommands.length,
      attributed: innerCommands.every((command) =>
        command.environmentFrameId === context.environment?.id
      ),
    };
  }), { timeout: 10_000 }).toEqual({ count: 2, attributed: true });
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

  await terminalInput.pressSequentially(
    "test \"$SB_RC_BEFORE\" = \"$(docker exec stackbridge-m0b1-ubuntu22 /bin/sh -c 'if [ -f \"$HOME/.bashrc\" ]; then sha256sum \"$HOME/.bashrc\" | cut -d\" \" -f1; else printf MISSING; fi')\" && printf 'DOCKER_RC_UNCHANGED_OK\\n'",
    { delay: 2 },
  );
  await terminalInput.press("Enter");
  await expect(terminalRows).toContainText("DOCKER_RC_UNCHANGED_OK", { timeout: 10_000 });

  await terminalInput.pressSequentially(
    "SB_ZSH_RC_BEFORE=\"$(docker exec pedantic_vaughan /bin/sh -c 'if [ -f \"$HOME/.zshrc\" ]; then sha256sum \"$HOME/.zshrc\" | cut -d\" \" -f1; else printf MISSING; fi')\"; printf 'SB_ZSH_RC_BASELINE_READY\\n'",
    { delay: 2 },
  );
  await terminalInput.press("Enter");
  await expect(terminalRows).toContainText("SB_ZSH_RC_BASELINE_READY", { timeout: 10_000 });

  await terminalInput.pressSequentially("docker exec -it pedantic_vaughan zsh", { delay: 4 });
  await terminalInput.press("Enter");
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).toContainText(
    "Docker: pedantic_vaughan",
    { timeout: 10_000 },
  );
  const zshBreadcrumb = "Local Windows → SSH: friden-dev-cube → Docker: pedantic_vaughan";
  const zshBreadcrumbCount = async () => {
    const text = await terminalRows.textContent();
    return text === null ? 0 : text.split(zshBreadcrumb).length - 1;
  };
  await expect(terminalRows).toContainText(zshBreadcrumb, { timeout: 10_000 });

  await terminalInput.pressSequentially("printf 'DOCKER_ZSH_PROMPT_ONE\\n'", { delay: 4 });
  await terminalInput.press("Enter");
  await expect(terminalRows).toContainText("DOCKER_ZSH_PROMPT_ONE", { timeout: 10_000 });
  await expect.poll(zshBreadcrumbCount, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

  await terminalInput.pressSequentially("printf 'DOCKER_ZSH_PROMPT_TWO\\n'", { delay: 4 });
  await terminalInput.press("Enter");
  await expect(terminalRows).toContainText("DOCKER_ZSH_PROMPT_TWO", { timeout: 10_000 });
  await expect.poll(zshBreadcrumbCount, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

  await terminalInput.pressSequentially("exit", { delay: 4 });
  await terminalInput.press("Enter");
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).not.toContainText(
    "Docker:",
    { timeout: 10_000 },
  );
  await terminalInput.pressSequentially(
    "test \"$SB_ZSH_RC_BEFORE\" = \"$(docker exec pedantic_vaughan /bin/sh -c 'if [ -f \"$HOME/.zshrc\" ]; then sha256sum \"$HOME/.zshrc\" | cut -d\" \" -f1; else printf MISSING; fi')\" && printf 'DOCKER_ZSH_RC_UNCHANGED_OK\\n'",
    { delay: 2 },
  );
  await terminalInput.press("Enter");
  await expect(terminalRows).toContainText("DOCKER_ZSH_RC_UNCHANGED_OK", { timeout: 10_000 });

  await terminalInput.pressSequentially("printf 'CLEAR_SENTINEL\\n'", { delay: 4 });
  await terminalInput.press("Enter");
  await expect(terminalRows).toContainText("CLEAR_SENTINEL", { timeout: 10_000 });
  const clearFrameStart = terminalOutputFrames.length;
  await terminalInput.pressSequentially("clear", { delay: 4 });
  await terminalInput.press("Enter");
  await expect.poll(
    () => Buffer.from(terminalOutputFrames.slice(clearFrameStart).join(""), "utf8").toString("hex"),
    { timeout: 10_000 },
  ).toContain("1b5b481b5b324a1b5b334a");
  await expect(terminalRows).not.toContainText("CLEAR_SENTINEL", { timeout: 10_000 });
});

test("uses UTF-8 and xterm capabilities for a hand-typed SSH target", async ({ page }) => {
  const target = process.env.STACKBRIDGE_E2E_UTF8_SSH;
  test.skip(!target, "requires an SSH target with an interactive Zsh prompt");
  test.setTimeout(45_000);
  await page.goto("/");

  const rows = page.locator(".terminal-host .xterm-rows");
  const input = page.locator(".terminal-host .xterm-helper-textarea");
  await input.focus();
  await input.pressSequentially(`ssh ${target}`, { delay: 8 });
  await input.press("Enter");
  await expect(page.locator(".terminal-pane-shell.active .environment-main")).toContainText(
    `SSH: ${target}`,
    { timeout: 20_000 },
  );
  await expect(rows).toContainText("➜", { timeout: 20_000 });
  await input.pressSequentially("printf 'SB_TERM=%s\\n' \"$TERM\"; locale charmap; printf 'UTF8_PROMPT_READY\\n'", { delay: 4 });
  await input.press("Enter");

  await expect(rows).toContainText("UTF8_PROMPT_READY", { timeout: 10_000 });
  await expect(rows).toContainText("SB_TERM=xterm-256color", { timeout: 10_000 });
  await expect(rows).toContainText("UTF-8", { timeout: 10_000 });
  await expect(rows).toContainText("➜", { timeout: 10_000 });
  await expect(rows).not.toContainText("?➜");
  await expect(rows).not.toContainText("??????");
});
