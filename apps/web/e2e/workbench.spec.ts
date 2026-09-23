import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const screenshotDirectory = resolve(here, "../../../artifacts/playwright");
const workbenchUrl = process.env.STACKBRIDGE_WEB_URL ?? "http://127.0.0.1:5173";

test.beforeAll(() => mkdirSync(screenshotDirectory, { recursive: true }));

test("configures DeepSeek from the AI rail without exposing its API key", async ({ page }) => {
  let configured = false;
  let savedModel = "deepseek-flash";
  let conversation: Record<string, unknown> | undefined;
  let turnCount = 0;
  const conversationId = "00000000-0000-4000-8000-000000000101";
  const createdAt = "2026-09-21T00:00:00.000Z";
  const selectedCommandId = "00000000-0000-4000-8000-000000000901";
  await page.route("**/v1/terminal-sessions/*/ai-context", async (route) => {
    const selection = route.request().postDataJSON() as { contextMode: string; commandIds?: string[] };
    const count = selection.contextMode === "none" ? 0 : selection.contextMode === "manual" ? selection.commandIds?.length ?? 0 : 3;
    await route.fulfill({ json: { preparedId: "00000000-0000-4000-8000-000000000911", attachments: [], bytes: selection.contextMode === "none" ? 0 : 512 + count * 1024, outputCount: count, commands: [
      { id: selectedCommandId, command: "echo SELECT_ME", cwd: "C:\\work", exitCode: 0, output: "SELECT_ME" },
      { id: "00000000-0000-4000-8000-000000000902", command: "echo IGNORE_ME", cwd: "C:\\work", exitCode: 0, output: "IGNORE_ME" },
      { id: "00000000-0000-4000-8000-000000000903", command: "echo THIRD", cwd: "C:\\work", exitCode: 0, output: "THIRD" },
    ] } });
  });
  await page.route("**/v1/ai/account/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 2,
        available: true,
        authenticated: true,
        accountLabel: "Playwright ChatGPT",
      }),
    });
  });
  await page.route("**/v1/ai/providers", async (route) => {
    if (route.request().method() !== "GET") return await route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [
        {
          id: "chatgpt",
          kind: "chatgpt",
          label: "ChatGPT",
          available: true,
          configured: true,
          authenticated: true,
          credentialPersistence: "codex-managed",
        },
        {
          id: "deepseek",
          kind: "deepseek",
          label: "DeepSeek",
          available: true,
          configured,
          authenticated: configured,
          credentialPersistence: "system-encrypted",
          hasApiKey: configured,
          baseUrl: "https://api.deepseek.com",
          model: savedModel,
        },
      ] }),
    });
  });
  await page.route("**/v1/ai/providers/deepseek/test", async (route) => {
    const input = route.request().postDataJSON() as { apiKey?: string; model?: string };
    expect(input.apiKey).toBe("ds-ui-secret");
    expect(input.model).toBe("deepseek-custom");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, model: input.model }) });
  });
  await page.route("**/v1/ai/providers/deepseek", async (route) => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON() as { apiKey?: string; model: string };
      expect(input.apiKey).toBe("ds-ui-secret");
      configured = true;
      savedModel = input.model;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "deepseek",
          kind: "deepseek",
          label: "DeepSeek",
          available: true,
          configured: true,
          authenticated: true,
          credentialPersistence: "system-encrypted",
          hasApiKey: true,
          baseUrl: "https://api.deepseek.com",
          model: savedModel,
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/v1/ai/models?providerId=deepseek", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [
        { id: "deepseek-flash", model: "deepseek-flash", displayName: "DeepSeek Flash", description: "", isDefault: true },
        { id: "deepseek-v4-pro", model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", description: "", isDefault: false },
        ...(configured && savedModel === "deepseek-custom"
          ? [{ id: savedModel, model: savedModel, displayName: savedModel, description: "Custom DeepSeek model", isDefault: false }]
          : []),
      ] }),
    });
  });
  await page.route("**/v1/conversations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: conversation === undefined ? [] : [conversation] }),
      });
      return;
    }
    const input = route.request().postDataJSON() as { providerId?: string; model?: string };
    expect(input).toMatchObject({ providerId: "deepseek", model: "deepseek-custom" });
    conversation = {
      schemaVersion: 2,
      id: conversationId,
      title: "New conversation",
      providerId: "deepseek",
      model: "deepseek-custom",
      createdAt,
      updatedAt: createdAt,
      messages: [],
      proposals: [],
    };
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(conversation) });
  });
  await page.route("**/v1/conversations/*/turns", async (route) => {
    expect(route.request().url()).toContain(conversationId);
    const input = route.request().postDataJSON() as { message: string };
    turnCount += 1;
    const timestamp = `2026-09-21T00:00:0${turnCount}.000Z`;
    const messages = (conversation?.messages as unknown[] | undefined) ?? [];
    conversation = {
      ...conversation,
      title: "DeepSeek routed conversation",
      updatedAt: timestamp,
      messages: [
        ...messages,
        {
          schemaVersion: 2,
          id: `00000000-0000-4000-8000-0000000002${turnCount}1`,
          role: "user",
          content: input.message,
          createdAt: timestamp,
        },
        {
          schemaVersion: 2,
          id: `00000000-0000-4000-8000-0000000002${turnCount}2`,
          role: "assistant",
          content: `DeepSeek routed answer ${turnCount}\n\n**CPU** and \`uname -a\`\n\n- Linux host\n\n\`\`\`sh\nprintf 'hello'\n\`\`\`\n\n| Item | Value |\n| --- | --- |\n| CPU | AMD |\n\n<script>window.markdownExecuted = true</script>\n\n[unsafe](javascript:alert(1))\n\n![remote](https://example.invalid/tracker.png)`,
          createdAt: timestamp,
          proposalIds: [],
        },
      ],
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(conversation) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await page.locator(".model-settings > summary").click();
  const providerGroup = page.getByRole("group", { name: "AI provider" });
  await expect(providerGroup).toBeVisible();
  await providerGroup.getByRole("button", { name: /DeepSeek/ }).click();
  await expect(page.getByRole("heading", { name: "Configure DeepSeek API" })).toBeVisible();
  await page.getByLabel("Model").fill("deepseek-custom");
  await page.getByLabel("API Key").fill("ds-ui-secret");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("Connection successful")).toBeVisible();
  await page.getByRole("button", { name: "Save and use" }).click();
  await page.locator(".model-settings > summary").click();
  await expect(page.getByRole("button", { name: "Configure DeepSeek" })).toBeVisible();
  await expect(page.locator("input[type='password']")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("ds-ui-secret");

  const composer = page.getByPlaceholder("Ask about the current command, output, or next step…");
  await composer.fill("Route this through DeepSeek");
  await composer.press("Enter");
  await expect(page.getByText("DeepSeek routed answer 1")).toBeVisible();
  const fullReply = page.locator(".message.assistant .message-body").last();
  await expect(fullReply.locator("strong")).toHaveText("CPU");
  await expect(fullReply.locator("li")).toHaveText("Linux host");
  await expect(fullReply.locator("pre code")).toHaveText("printf 'hello'\n");
  await expect(fullReply.locator("table")).toContainText("AMD");
  await expect(fullReply.locator("script, img, a[href^='javascript:']")).toHaveCount(0);
  await expect(providerGroup.getByRole("button", { name: /ChatGPT/ })).toBeDisabled();
  await page.getByRole("button", { name: /New conversation/ }).click();
  await providerGroup.getByRole("button", { name: /ChatGPT/ }).click();
  await expect(providerGroup.getByRole("button", { name: /ChatGPT/ })).toHaveAttribute("aria-pressed", "true");

  await page.locator(".history-select").selectOption(conversationId);
  await expect(providerGroup.getByRole("button", { name: /DeepSeek/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".assistant-tools .model-input input")).toHaveValue("deepseek-custom");

  await page.locator(".panel-header .icon-button").click();
  await page.keyboard.press("F8");
  const quickAsk = page.locator(".terminal-pane-shell.active .inline-assistant");
  await expect(quickAsk).toBeVisible();
  await expect(quickAsk).toContainText("DeepSeek · deepseek-custom");
  await quickAsk.getByRole("button", { name: /Context ×/ }).click();
  await page.getByRole("dialog").getByLabel("Context mode").selectOption("none");
  await page.getByRole("button", { name: "Close context selection" }).click();
  await expect(quickAsk).toContainText("0.0 KiB");
  const nextTurn = page.waitForRequest((request) => request.url().endsWith(`/v1/conversations/${conversationId}/turns`));
  await quickAsk.locator("textarea").fill("Continue the DeepSeek conversation");
  await quickAsk.locator("textarea").press("Enter");
  expect((await nextTurn).postDataJSON()).toMatchObject({ preparedContextId: "00000000-0000-4000-8000-000000000911" });
  await expect(quickAsk.locator(".inline-ai-response")).toContainText("DeepSeek routed answer 2");
  await expect(quickAsk.locator(".message-body strong")).toHaveText("CPU");
  await expect(quickAsk.locator(".message-body pre code")).toHaveText("printf 'hello'\n");
  await expect(quickAsk.locator(".message-body table")).toContainText("AMD");
  await expect(quickAsk.locator(".message-body script, .message-body img, .message-body a[href^='javascript:']")).toHaveCount(0);
  await quickAsk.getByRole("button", { name: /Context ×/ }).click();
  await page.getByRole("dialog").getByLabel("Context mode").selectOption("manual");
  await page.getByRole("dialog").getByLabel("echo SELECT_ME", { exact: true }).check();
  await page.getByRole("button", { name: "Close context selection" }).click();
  await expect(quickAsk.getByRole("button", { name: "Context ×1" })).toBeVisible();
  const manualTurn = page.waitForRequest((request) => request.url().endsWith(`/v1/conversations/${conversationId}/turns`));
  await quickAsk.locator("textarea").fill("Only the selected block");
  await quickAsk.locator("textarea").press("Enter");
  expect((await manualTurn).postDataJSON()).toMatchObject({ preparedContextId: "00000000-0000-4000-8000-000000000911" });
  await expect(quickAsk.locator(".inline-ai-response")).toContainText("DeepSeek routed answer 3");
  await expect(quickAsk.locator(".inline-answer-preview")).toHaveCSS("overflow-y", "hidden");
  await expect(quickAsk.getByRole("button", { name: "Read full answer" })).toBeVisible();
  await quickAsk.getByRole("button", { name: /Context ×/ }).click();
  await page.getByRole("dialog").getByLabel("Context mode").selectOption("auto");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(quickAsk).toBeVisible();
  await expect(quickAsk.getByRole("button", { name: "Context ×3" })).toBeVisible();
  await expect(quickAsk).toContainText("DeepSeek · deepseek-custom");
  await page.screenshot({ path: resolve(screenshotDirectory, "quick-ask-context-selection.png") });
  await quickAsk.locator("textarea").fill("Keep this draft and its attachments");
  await quickAsk.getByRole("button", { name: "Open conversation", exact: true }).click();
  const dock = page.locator(".assistant-panel");
  await expect(quickAsk).toHaveCount(0);
  await expect(dock.locator("textarea")).toHaveValue("Keep this draft and its attachments");
  await expect(dock).toContainText("DeepSeek routed answer 3");
  await expect(dock.locator(".message.assistant .message-body").last()).toHaveCSS("font-size", "14px");
  await expect(dock.getByRole("button", { name: "Context ×3" })).toBeVisible();
  expect(turnCount).toBe(3);
  const originalWidth = (await dock.boundingBox())!.width;
  const divider = page.getByRole("separator", { name: "Resize AI panel" });
  await divider.focus();
  await divider.press("ArrowLeft");
  await expect.poll(async () => (await dock.boundingBox())!.width).toBeGreaterThan(originalWidth + 15);
  const dividerBox = (await divider.boundingBox())!;
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(dividerBox.x - 65, dividerBox.y + 100, { steps: 5 });
  await page.mouse.up();
  const resizedWidth = (await dock.boundingBox())!.width;
  expect(resizedWidth).toBeGreaterThan(originalWidth + 60);
  await dock.getByRole("button", { name: "Back to Quick Ask" }).click();
  await expect(quickAsk.locator("textarea")).toHaveValue("Keep this draft and its attachments");
  await quickAsk.getByRole("button", { name: "Open conversation", exact: true }).click();
  await expect.poll(async () => (await dock.boundingBox())!.width).toBeCloseTo(resizedWidth, 0);
  await page.screenshot({ path: resolve(screenshotDirectory, "ai-workspace-docked.png") });
  await page.setViewportSize({ width: 800, height: 700 });
  await expect.poll(async () => (await dock.boundingBox())!.width).toBeLessThan(740);
  await expect(dock.locator("textarea")).toBeVisible();
  expect(turnCount).toBe(3);
});

test("highlights whole command blocks and supports range dragging and a movable resizable Quick Ask", async ({ page }) => {
  await page.route("**/v1/ai/account/status", (route) => route.fulfill({ json: { schemaVersion: 2, available: true, authenticated: true } }));
  await page.route("**/v1/ai/providers", (route) => route.fulfill({ json: { data: [{ id: "chatgpt", kind: "chatgpt", label: "ChatGPT", available: true, configured: true, authenticated: true, credentialPersistence: "codex-managed" }] } }));
  await page.goto("/");
  const terminal = page.locator(".terminal-pane-shell.active .xterm-helper-textarea");
  await expect(page.locator(".terminal-status")).toContainText("Connected to real PTY");
  await expect(page.locator(".xterm-rows")).toContainText("Local Windows", { timeout: 15000 });
  for (const name of ["ONE", "TWO", "THREE", "FOUR"]) {
    await terminal.focus();
    await terminal.pressSequentially(`Write-Output 'CTX_${name}'`, { delay: 3 });
    await terminal.press("Enter");
    await expect(page.locator(".xterm-rows").getByText(`CTX_${name}`, { exact: true }).last()).toBeVisible();
  }
  await page.keyboard.press("F8");
  const quick = page.locator(".inline-assistant");
  await expect(quick.getByRole("button", { name: "Context ×3" })).toBeVisible();
  await expect(page.locator(".terminal-context-highlight")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Extend context start" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Extend context end" })).toHaveCount(1);
  await quick.getByRole("button", { name: "Context ×3" }).click();
  await page.getByRole("dialog").getByLabel("Context mode").selectOption("manual");
  await page.getByRole("dialog").getByLabel("Write-Output 'CTX_ONE'", { exact: true }).check();
  await page.getByRole("button", { name: "Close context selection" }).click();
  await expect(quick.getByRole("button", { name: "Context ×1" })).toBeVisible();
  await expect(page.locator(".terminal-context-highlight")).toHaveCount(1);
  const handle = await page.getByRole("button", { name: "Extend context end" }).boundingBox();
  const target = await page.locator(".xterm-rows").getByText("CTX_THREE", { exact: true }).last().boundingBox();
  expect(handle).not.toBeNull(); expect(target).not.toBeNull();
  await page.mouse.move(handle!.x + 5, handle!.y + 5); await page.mouse.down();
  await page.mouse.move(handle!.x + 5, target!.y + 5, { steps: 8 }); await page.mouse.up();
  await expect(quick.getByRole("button", { name: "Context ×3" })).toBeVisible();
  const before = await quick.boundingBox();
  const grip = await quick.getByLabel("Move Quick Ask").boundingBox();
  await page.mouse.move(grip!.x + 30, grip!.y + 5); await page.mouse.down();
  await page.mouse.move(grip!.x + 100, grip!.y - 65, { steps: 8 }); await page.mouse.up();
  await expect(quick).toHaveAttribute("data-placement", "fixed");
  const moved = await quick.boundingBox();
  expect(Math.abs(moved!.x - before!.x) + Math.abs(moved!.y - before!.y)).toBeGreaterThan(20);
  const resize = await quick.getByLabel("Resize Quick Ask").boundingBox();
  await page.mouse.move(resize!.x + 5, resize!.y + 5); await page.mouse.down();
  await page.mouse.move(resize!.x + 105, resize!.y + 85, { steps: 8 }); await page.mouse.up();
  const resized = await quick.boundingBox();
  expect(resized!.width).toBeGreaterThan(moved!.width + 50);
  await page.keyboard.press("Escape"); await page.keyboard.press("F8");
  await expect(quick).toHaveAttribute("data-placement", "fixed");
  await expect.poll(async () => (await quick.boundingBox())!.width).toBeCloseTo(resized!.width, 0);
  await page.screenshot({ path: resolve(screenshotDirectory, "terminal-context-highlights.png") });
  await quick.getByRole("button", { name: "Follow cursor" }).click();
  await expect(quick).not.toHaveAttribute("data-placement", "fixed");
  await page.keyboard.press("Escape");
  await terminal.focus();
  await terminal.pressSequentially("Clear-Host", { delay: 3 });
  await terminal.press("Enter");
  await expect(page.locator(".terminal-context-highlight")).toHaveCount(0);
  await expect(page.locator(".context-range-unavailable")).toBeVisible();
  await page.keyboard.press("F8");
  await expect(quick.getByRole("button", { name: "Context ×3" })).toBeVisible();
});

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
      body: JSON.stringify({ locale: "en", aiProviderId: "chatgpt" }),
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
    "1..8 | ForEach-Object { Write-Output \"FOLLOW_$($_)\"; Start-Sleep -Milliseconds 400 }",
    { delay: 2 },
  );
  await terminalInput.press("Enter");
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText("FOLLOW_1");
  await page.keyboard.press("F8");
  const followingAssistant = page.locator(".terminal-pane-shell.active .inline-assistant");
  await expect(followingAssistant).toBeVisible();
  await expect.poll(async () => {
    const box = await followingAssistant.boundingBox();
    const cursor = await page.locator(".terminal-pane-shell.active .xterm-cursor").boundingBox();
    return box && cursor ? Math.min(Math.abs(box.y - cursor.y - cursor.height), Math.abs(box.y + box.height - cursor.y)) : Infinity;
  }).toBeLessThan(20);
  const followingStartBox = await followingAssistant.boundingBox();
  expect(followingStartBox).not.toBeNull();
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText("FOLLOW_8", { timeout: 10_000 });
  await expect.poll(async () => {
    const currentBox = await followingAssistant.boundingBox();
    return currentBox !== null && currentBox.y > followingStartBox!.y + 30;
  }).toBe(true);
  await page.keyboard.press("Escape");

  await terminalInput.focus();
  await terminalInput.pressSequentially("Write-Output BUFFER_", { delay: 8 });
  await expect(page.locator(".terminal-host .xterm-rows")).toContainText("Write-Output BUFFER_");
  const terminalBoxBeforeQuickAsk = await page.locator(".terminal-pane-shell.active .terminal-host").boundingBox();
  const terminalCursor = page.locator(".terminal-pane-shell.active .xterm-cursor");
  await expect.poll(() => terminalCursor.count()).toBeGreaterThan(0);
  await expect.poll(() => terminalCursor.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(0);
  const cursorBoxBeforeQuickAsk = await terminalCursor.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await page.keyboard.press("F8");
  const inlineAssistant = page.locator(".terminal-pane-shell.active .inline-assistant");
  await expect(inlineAssistant).toBeVisible();
  await expect(page.locator(".assistant-panel")).toHaveCount(0);
  await expect.poll(async () => {
    const box = await inlineAssistant.boundingBox();
    return box === null ? Infinity : Math.min(
      Math.abs(box.y - (cursorBoxBeforeQuickAsk.y + cursorBoxBeforeQuickAsk.height)),
      Math.abs(box.y + box.height - cursorBoxBeforeQuickAsk.y),
    );
  }).toBeLessThan(20);
  const terminalBoxWithQuickAsk = await page.locator(".terminal-pane-shell.active .terminal-host").boundingBox();
  const quickAskBox = await inlineAssistant.boundingBox();
  expect(terminalBoxBeforeQuickAsk).not.toBeNull();
  expect(terminalBoxWithQuickAsk).not.toBeNull();
  expect(cursorBoxBeforeQuickAsk).not.toBeNull();
  expect(quickAskBox).not.toBeNull();
  expect(Math.abs(terminalBoxWithQuickAsk!.height - terminalBoxBeforeQuickAsk!.height)).toBeLessThan(2);
  // Readable provider / attachment controls fit in a compact, five-row composer.
  expect(quickAskBox!.height).toBeLessThanOrEqual(210);
  await expect(inlineAssistant.locator(".ask-context-heading")).toContainText("ChatGPT");
  expect(quickAskBox!.width).toBeLessThanOrEqual(430);
  const distanceToCursor = Math.min(
    Math.abs(quickAskBox!.y - (cursorBoxBeforeQuickAsk!.y + cursorBoxBeforeQuickAsk!.height)),
    Math.abs((quickAskBox!.y + quickAskBox!.height) - cursorBoxBeforeQuickAsk!.y),
  );
  expect(distanceToCursor).toBeLessThan(20);
  await expect(inlineAssistant.locator(".inline-context-strip")).toHaveCount(0);
  const contextIndicator = inlineAssistant.locator(".inline-context-indicator");
  await expect(contextIndicator).toBeVisible();
  await expect(contextIndicator).toHaveAttribute("type", "button");
  await expect(contextIndicator).toHaveAttribute("title", /Local Windows.*powershell/i);
  await expect(inlineAssistant.getByRole("button", { name: "History & details" })).toHaveCount(0);
  await expect(inlineAssistant.getByRole("button", { name: "Close Quick Ask" })).toHaveCount(0);
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
  await contextIndicator.click();
  await expect(inlineAssistant).toHaveCount(0);
  await expect(page.locator(".assistant-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(terminalInput).toBeFocused();
  await page.keyboard.press("F8");
  await expect(inlineAssistant).toBeVisible();
  await page.keyboard.press("F8");
  await expect(inlineAssistant).toHaveCount(0);
  await expect(terminalInput).toBeFocused();
  await terminalInput.pressSequentially("PRESERVED", { delay: 8 });
  await terminalInput.press("Enter");
  const activeSessionId = await page.locator(".terminal-pane-shell.active").getAttribute("data-terminal-session-id");
  expect(activeSessionId).not.toBeNull();
  await expect.poll(() => page.evaluate(async (sessionId) => {
    const response = await fetch(`/v1/terminal-sessions/${sessionId}/commands`);
    const body = await response.json() as { data: Array<{ command: string }> };
    return body.data.at(-1)?.command;
  }, activeSessionId)).toBe("Write-Output BUFFER_PRESERVED");

  await terminalInput.focus();
  await terminalInput.pressSequentially("1..80 | ForEach-Object { Write-Output $_ }; Write-Output 'SCROLL_END_80'", { delay: 2 });
  await terminalInput.press("Enter");
  await expect.poll(() => page.evaluate(async (sessionId) => {
    const response = await fetch(`/v1/terminal-sessions/${sessionId}/commands`);
    const body = await response.json() as { data: Array<{ command: string }> };
    return body.data.at(-1)?.command;
  }, activeSessionId)).toBe("1..80 | ForEach-Object { Write-Output $_ }; Write-Output 'SCROLL_END_80'");
  await expect(page.locator(".terminal-pane-shell.active .xterm-rows")).toContainText("SCROLL_END_80");
  await expect.poll(async () => {
    const terminalBox = await page.locator(".terminal-pane-shell.active .terminal-host").boundingBox();
    const cursorBox = await page.locator(".terminal-pane-shell.active .xterm-cursor").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    return terminalBox !== null && cursorBox !== null
      && cursorBox.height > 0 && cursorBox.y < terminalBox.y + terminalBox.height
      && cursorBox.y > terminalBox.y + terminalBox.height - 80;
  }).toBe(true);
  const terminalBoxBeforeFlippedQuickAsk = await page.locator(".terminal-pane-shell.active .terminal-host").boundingBox();
  const cursorBoxBeforeFlippedQuickAsk = await page.locator(".terminal-pane-shell.active .xterm-cursor").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await page.keyboard.press("F8");
  await expect(inlineAssistant).toHaveAttribute("data-placement", "above");
  const terminalBoxWithFlippedQuickAsk = await page.locator(".terminal-pane-shell.active .terminal-host").boundingBox();
  const flippedQuickAskBox = await inlineAssistant.boundingBox();
  expect(terminalBoxBeforeFlippedQuickAsk).not.toBeNull();
  expect(cursorBoxBeforeFlippedQuickAsk).not.toBeNull();
  expect(terminalBoxWithFlippedQuickAsk).not.toBeNull();
  expect(flippedQuickAskBox).not.toBeNull();
  expect(Math.abs(terminalBoxWithFlippedQuickAsk!.height - terminalBoxBeforeFlippedQuickAsk!.height)).toBeLessThan(2);
  await expect.poll(async () => {
    const box = await inlineAssistant.boundingBox();
    const cursor = await page.locator(".terminal-pane-shell.active .xterm-cursor").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { y: rect.y, height: rect.height };
    });
    return box !== null && cursor.height > 0 && Math.abs(box.y + box.height - cursor.y) < 20;
  }).toBe(true);
  await page.keyboard.press("Escape");
});

test("asks the real Codex account from the active terminal pane", async ({ page }) => {
  test.skip(process.env.STACKBRIDGE_E2E_AI !== "1", "requires an authenticated ChatGPT account");
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.locator(".terminal-pane-context")).toContainText("Local Windows");

  await page.keyboard.press("F8");
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
  const answeredQuickAskBox = await inlineAssistant.boundingBox();
  expect(answeredQuickAskBox).not.toBeNull();
  expect(answeredQuickAskBox!.width).toBeLessThanOrEqual(530);
  expect(answeredQuickAskBox!.height).toBeLessThanOrEqual(205);
  await page.screenshot({
    path: resolve(screenshotDirectory, "09-cursor-anchored-ai-response.png"),
    fullPage: true,
  });
  await expect(page.locator(".assistant-panel")).toHaveCount(0);
});

test("passes terminal question marks to PowerShell without opening Quick Ask", async ({ page }) => {
  await page.goto("/");
  const pane = page.locator(".terminal-pane-shell.active");
  const terminalInput = pane.locator(".xterm-helper-textarea");
  await expect(pane.locator(".terminal-pane-context")).toContainText("Local Windows");
  await expect(pane.locator(".xterm-rows")).toContainText("PS ", { timeout: 10_000 });

  await terminalInput.focus();
  await terminalInput.pressSequentially("??", { delay: 40 });
  await terminalInput.press("Enter");

  await expect(pane.locator(".inline-assistant")).toHaveCount(0);
  await expect(pane.locator(".xterm-rows")).toContainText("CommandNotFoundException");
});

test("passes full-width question marks to PowerShell without opening Quick Ask", async ({ page }) => {
  await page.goto("/");
  const pane = page.locator(".terminal-pane-shell.active");
  const terminalInput = pane.locator(".xterm-helper-textarea");
  await expect(pane.locator(".terminal-pane-context")).toContainText("Local Windows");
  await expect(pane.locator(".xterm-rows")).toContainText("PS ", { timeout: 10_000 });

  await terminalInput.focus();
  await page.keyboard.insertText("？？");
  await terminalInput.press("Enter");

  await expect(pane.locator(".inline-assistant")).toHaveCount(0);
  await expect(pane.locator(".xterm-rows")).toContainText("CommandNotFoundException");
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
  await page.keyboard.press("F8");
  await panes.nth(0).locator(".inline-assistant textarea").fill("FIRST_PANE_DRAFT");
  await page.keyboard.press("Escape");
  await panes.nth(1).locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("F8");
  await expect(panes.nth(1).locator(".inline-assistant textarea")).toHaveValue("");
  await panes.nth(1).locator(".inline-assistant textarea").fill("SECOND_PANE_DRAFT");
  await page.keyboard.press("Escape");
  await panes.nth(0).locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("F8");
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
  await page.keyboard.press("F8");
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
