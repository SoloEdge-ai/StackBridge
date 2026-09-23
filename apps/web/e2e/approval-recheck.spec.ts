import { expect, test, type Route } from "@playwright/test";
import type { CommandProposal, ConversationSnapshot } from "@stackbridge/protocol";

test("keeps stale feedback on its card and requires a separate approval after recheck", async ({ page }) => {
  const date = "2026-09-23T00:00:00.000Z";
  const proposal: CommandProposal = { schemaVersion: 2, id: "00000000-0000-4000-8000-000000000301",
    conversationId: "00000000-0000-4000-8000-000000000101", agentSessionId: "00000000-0000-4000-8000-000000000201",
    terminalSessionId: "00000000-0000-4000-8000-000000000401", environmentFrameId: "local-test", environmentKind: "local",
    environmentLabel: "Local Windows", bindingId: "original-binding", purpose: "Current date", command: "Get-Date",
    cwd: "C:\\original", shell: "powershell", user: "test", createdAt: date, expiresAt: date, status: "pending" };
  const conversation: ConversationSnapshot = { schemaVersion: 2, id: proposal.conversationId, providerId: "chatgpt",
    title: "Recheck test", model: "gpt-5.6-luna", createdAt: date, updatedAt: date, proposals: [proposal],
    messages: [{ schemaVersion: 2, id: "00000000-0000-4000-8000-000000000501", role: "assistant", content: "Check the date", createdAt: date, proposalIds: [proposal.id] }] };
  let recheckRoute: Route | undefined;
  const decisions: string[] = [];
  await page.route("**/v1/settings", r => r.fulfill({ json: { aiProviderId: "chatgpt" } }));
  await page.route("**/v1/ai/account/status", r => r.fulfill({ json: { schemaVersion: 2, available: true, authenticated: true } }));
  await page.route("**/v1/ai/providers", r => r.fulfill({ json: { data: [{ id: "chatgpt", label: "ChatGPT", available: true, configured: true, authenticated: true }] } }));
  await page.route("**/v1/ai/models?providerId=chatgpt", r => r.fulfill({ json: { data: [] } }));
  await page.route("**/v1/conversations", r => r.fulfill({ json: { data: [conversation] } }));
  await page.route(`**/v1/conversations/${conversation.id}`, r => r.fulfill({ json: conversation }));
  await page.route("**/v1/approvals/*/decision", r => {
    decisions.push(r.request().url());
    if (r.request().url().includes(proposal.id)) {
      proposal.status = "stale";
      return r.fulfill({ status: 409, json: { error: "proposal_stale", message: "Terminal context changed; confirm the command again" } });
    }
    const renewed = conversation.proposals[1]!;
    renewed.status = "accepted";
    return r.fulfill({ json: { proposal: renewed } });
  });
  await page.route("**/v1/approvals/*/recheck", r => { recheckRoute = r; });
  await page.goto("/");
  await expect(page.locator(".terminal-status")).toContainText("Connected to real PTY");
  const terminalId = await page.locator(".terminal-pane-shell.active").getAttribute("data-terminal-session-id");
  try {
    await page.getByRole("button", { name: "AI assistant", exact: true }).click();
    await page.getByLabel("Conversation history").selectOption(conversation.id);
    const card = page.locator(".proposal-card");
    await card.getByRole("button", { name: "Run in this terminal" }).click();
    await expect(page.locator(".panel-error")).toHaveCount(0);
    await expect(card).toContainText("Terminal state changed");
    await card.getByRole("button", { name: "Recheck for confirmation" }).click();
    await expect(card.getByRole("button", { name: "Rechecking…" })).toBeDisabled();
    await expect.poll(() => !!recheckRoute).toBe(true);
    expect(decisions).toHaveLength(1);
    const renewed: CommandProposal = { ...proposal, id: "00000000-0000-4000-8000-000000000302", status: "pending", replacesProposalId: proposal.id };
    proposal.replacementProposalId = renewed.id;
    conversation.proposals.push(renewed);
    await recheckRoute!.fulfill({ json: { proposal: renewed } });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Rechecked. Review the command and original target, then confirm.");
    await expect(card).toContainText("C:\\original");
    expect(decisions).toHaveLength(1);
    await card.getByRole("button", { name: "Run in this terminal" }).click();
    await expect(card).toContainText("Submitted");
    expect(decisions).toHaveLength(2);
  } finally {
    if (terminalId) await page.request.delete(`/v1/terminal-sessions/${terminalId}`, { headers: { origin: new URL(page.url()).origin } });
  }
});
