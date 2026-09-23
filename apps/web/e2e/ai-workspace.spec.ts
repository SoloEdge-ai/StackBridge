import { expect, test, type Route } from "@playwright/test";
import type { ConversationSnapshot } from "@stackbridge/protocol";

test.afterEach(async ({ page }) => {
  const terminalId = await page.locator(".terminal-pane-shell.active").getAttribute("data-terminal-session-id").catch(() => null);
  if (terminalId) await page.request.delete(`/v1/terminal-sessions/${terminalId}`, { headers: { origin: new URL(page.url()).origin } });
});

test("shares manual attachments and an in-flight turn when moving between Quick Ask and the dock", async ({ page }) => {
  const conversationId = "00000000-0000-4000-8000-000000000101";
  const preparedId = "00000000-0000-4000-8000-000000000911";
  const commandId = "00000000-0000-4000-8000-000000000901";
  const createdAt = "2026-09-23T00:00:00.000Z";
  const conversation: ConversationSnapshot = {
    schemaVersion: 2, id: conversationId, title: "Shared conversation", providerId: "chatgpt",
    model: "gpt-5.6-luna", createdAt, updatedAt: createdAt, messages: [], proposals: [],
  };
  let creations = 0;
  let pending: Route | undefined;
  const turns: Array<{ message: string; terminalSessionId: string; preparedContextId: string }> = [];
  await page.route("**/v1/settings", (route) => route.fulfill({ json: { aiProviderId: "chatgpt" } }));
  await page.route("**/v1/ai/account/status", (route) => route.fulfill({ json: { schemaVersion: 2, available: true, authenticated: true } }));
  await page.route("**/v1/ai/providers", (route) => route.fulfill({ json: { data: [{ id: "chatgpt", kind: "chatgpt", label: "ChatGPT", available: true, configured: true, authenticated: true, credentialPersistence: "codex-managed" }] } }));
  await page.route("**/v1/ai/models?providerId=chatgpt", (route) => route.fulfill({ json: { data: [{ id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", description: "", isDefault: true }] } }));
  await page.route("**/v1/conversations", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { data: creations ? [conversation] : [] } });
    creations += 1;
    expect(route.request().postDataJSON()).toMatchObject({ providerId: "chatgpt", model: "gpt-5.6-luna" });
    return route.fulfill({ status: 201, json: conversation });
  });
  await page.route("**/v1/terminal-sessions/*/ai-context", (route) => {
    const selection = route.request().postDataJSON() as { contextMode: string; commandIds?: string[] };
    const selected = selection.contextMode === "manual" && selection.commandIds?.includes(commandId);
    return route.fulfill({ json: { preparedId, attachments: [], bytes: selected ? 1024 : 0, outputCount: selected ? 1 : 0,
      commands: [{ id: commandId, command: "echo ATTACH_ME", cwd: "C:\\work", exitCode: 0, output: "ATTACH_ME" }],
    } });
  });
  await page.route("**/v1/conversations/*/turns", (route) => {
    expect(route.request().url()).toContain(conversationId);
    turns.push(route.request().postDataJSON());
    pending = route;
  });
  await page.goto("/");
  await expect(page.locator(".terminal-status")).toContainText("Connected to real PTY");
  const terminalId = await page.locator(".terminal-pane-shell.active").getAttribute("data-terminal-session-id");
  await page.keyboard.press("F8");
  const quick = page.locator(".inline-assistant");
  await expect(quick.locator(".context-source")).toHaveCount(0);
  await expect(quick.locator(".ask-context-summary")).toHaveCount(0);
  await expect(quick.getByRole("button", { name: "Context ×0" })).toContainText("Auto");
  expect((await quick.boundingBox())!.height).toBeLessThan(155);
  await quick.getByRole("button", { name: /Context ×/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Local Windows");
  await expect(dialog).toContainText("Send to ChatGPT");
  await page.keyboard.press("F8");
  await expect(dialog).toBeVisible();
  await expect(quick).toBeVisible();
  await dialog.getByLabel("Context mode").selectOption("manual");
  await dialog.getByLabel("echo ATTACH_ME", { exact: true }).check();
  await page.keyboard.press("Escape");
  await quick.locator("textarea").fill("Explain the selected output");
  await quick.getByRole("button", { name: "Open conversation", exact: true }).click();
  const dock = page.locator(".assistant-panel");
  await expect(dock.locator("textarea")).toHaveValue("Explain the selected output");
  await expect(dock.getByRole("button", { name: "Context ×1" })).toBeVisible();
  await dock.getByRole("button", { name: "Remove attachment: echo ATTACH_ME" }).click();
  await expect(dock.getByRole("button", { name: "Context ×0" })).toBeVisible();
  await dock.getByRole("button", { name: "Back to Quick Ask" }).click();
  await expect(quick.getByRole("button", { name: "Context ×0" })).toBeVisible();
  await quick.getByRole("button", { name: /Context ×/ }).click();
  await expect(dialog.getByLabel("Context mode")).toHaveValue("manual");
  await expect(dialog.getByLabel("echo ATTACH_ME", { exact: true })).not.toBeChecked();
  await dialog.getByLabel("echo ATTACH_ME", { exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(quick.getByRole("button", { name: "Context ×1" })).toBeVisible();
  await quick.locator("textarea").press("Enter");
  await expect(quick.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(quick.locator(".inline-ai-pending")).toHaveCount(0);
  await expect.poll(() => turns.length).toBe(1);
  await quick.getByRole("button", { name: "Open conversation", exact: true }).click();
  await expect(dock.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(dock.locator("textarea")).toBeDisabled();
  await expect(dock.getByRole("button", { name: "Remove attachment: echo ATTACH_ME" })).toBeDisabled();
  await expect(dock).toContainText("Explain the selected output");
  await expect(dock).toContainText("ChatGPT · GPT-5.6 Luna");
  expect(turns).toEqual([{ schemaVersion: 2, message: "Explain the selected output", terminalSessionId: terminalId, preparedContextId: preparedId }]);
  expect(creations).toBe(1);
  conversation.messages.push({ schemaVersion: 2, id: "00000000-0000-4000-8000-000000000202", role: "assistant", content: "One shared answer", createdAt, proposalIds: [] });
  await pending!.fulfill({ json: conversation });
  await expect(dock.getByText("One shared answer", { exact: true })).toBeVisible();
  await expect(dock.locator("textarea")).toBeEnabled();
  await dock.getByRole("button", { name: "Back to Quick Ask" }).click();
  await expect(quick.getByText("One shared answer", { exact: true })).toBeVisible();
  expect(turns).toHaveLength(1);
});
