import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createCoreServer, type CoreServer } from "./server.js";
import { ConversationService } from "./conversation-service.js";
import { TerminalSessionManager } from "./terminal-session.js";
import { ControlledPty } from "./test/controlled-pty.js";
import type { CommandProposal, ConversationSnapshot } from "@stackbridge/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "./workspace-store.js";

const origin = "http://127.0.0.1:5173";
const token = "recheck-test-shell-token";
describe("Core HTTP proposal recheck", () => {
  let core: CoreServer;
  const sockets: WebSocket[] = [];
  let store: WorkspaceStore | undefined;
  let directory: string | undefined;
  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      if (socket.readyState === WebSocket.CLOSED) continue;
      await new Promise<void>((resolve) => { socket.once("close", resolve); socket.close(); });
    }
    await core?.close();
    store?.close(); store = undefined;
    if (directory) { rmSync(directory, { recursive: true, force: true }); directory = undefined; }
  });

  async function setup(now?: () => Date) {
    const pty = new ControlledPty();
    const terminals = new TerminalSessionManager(() => pty, { shellIntegrationTokenFactory: () => token });
    const conversations = new ConversationService(terminals, {
      async startSession() { return "recheck-thread"; },
      async runTurn() { return { answer: "Two checks", proposals: [
        { purpose: "Current directory", command: "Get-Location" }, { purpose: "Current date", command: "Get-Date" },
      ] }; },
    }, now, store);
    core = createCoreServer({ allowedOrigins: [origin], terminalSessions: terminals, conversations });
    await core.listen({ host: "127.0.0.1", port: 0 });
    const address = core.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const base = `http://127.0.0.1:${address.port}`;
    const authenticate = async () => {
      const response = await fetch(`${base}/v1/auth/session`, { method: "POST", headers: { origin } });
      return response.headers.get("set-cookie")!.split(";")[0]!;
    };
    const cookie = await authenticate();
    const post = (path: string, body: object, owner = cookie) => fetch(`${base}${path}`, {
      method: "POST", headers: { origin, cookie: owner, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const created = await post("/v1/terminal-sessions", { cols: 100, rows: 30 });
    const { id: terminalId } = await created.json() as { id: string };
    const source = { cwd: "C:\\work", shell: "powershell", user: "test" };
    const emit = (event: object) => pty.emitData(`\u001b]777;stackbridge;${token};${Buffer.from(JSON.stringify(event)).toString("base64url")}\u0007`);
    emit({ type: "prompt", ...source });
    const socket = new WebSocket(`${base.replace("http", "ws")}/v1/terminal-sessions/${terminalId}/stream`, { headers: { origin, cookie } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("message", () => resolve()); socket.once("error", reject); });
    const c = await post("/v1/conversations", { schemaVersion: 2, terminalSessionId: terminalId });
    const conversation = await c.json() as ConversationSnapshot;
    const turn = await post(`/v1/conversations/${conversation.id}/turns`, { schemaVersion: 2, terminalSessionId: terminalId, message: "Two checks" });
    const snapshot = await turn.json() as ConversationSnapshot;
    const first = snapshot.proposals[0]!;
    const second = snapshot.proposals[1]!;
    const decide = (id: string) => post(`/v1/approvals/${id}/decision`, { decision: "execute" });
    const recheck = (id: string, body = {}, owner = cookie) => post(`/v1/approvals/${id}/recheck`, body, owner);
    const completeFirst = async () => {
      expect((await decide(first.id)).status).toBe(200);
      emit({ type: "commandStart", command: first.command, ...source });
      pty.emitData("C:\\work\r\n");
      emit({ type: "commandEnd", cwd: source.cwd, exitCode: 0 });
      emit({ type: "prompt", ...source });
    };
    return { pty, post, recheck, decide, first, second, emit, source, completeFirst, authenticate,
      closeTerminal: () => fetch(`${base}/v1/terminal-sessions/${terminalId}`, { method: "DELETE", headers: { origin, cookie } }),
      async typeInput(data: string) {
        socket.send(JSON.stringify({ type: "input", data }));
        await expect.poll(() => pty.writes.at(-1)).toBe(data);
      },
      snapshot: async () => (await fetch(`${base}/v1/conversations/${conversation.id}`, { headers: { cookie } })).json() as Promise<ConversationSnapshot> };
  }

  it("rechecks a stale sibling into a new pending proposal, without executing until a separate approval", async () => {
    const h = await setup();
    await h.completeFirst();
    const stale = await h.decide(h.second.id);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "proposal_stale" });
    const checked = await h.recheck(h.second.id);
    expect(checked.status).toBe(200);
    const { proposal } = await checked.json() as { proposal: CommandProposal };
    expect(proposal.id).not.toBe(h.second.id);
    expect(proposal.agentSessionId).not.toBe(h.second.agentSessionId);
    expect(proposal).toMatchObject({ command: "Get-Date", terminalSessionId: h.second.terminalSessionId, bindingId: h.second.bindingId, cwd: "C:\\work", status: "pending" });
    expect(h.pty.writes).toEqual(["Get-Location\r"]);
    expect(await (await h.recheck(h.second.id)).json()).toMatchObject({ proposal: { id: proposal.id } });
    expect((await h.snapshot()).proposals).toHaveLength(3);
    await h.decide(h.second.id);
    expect(h.pty.writes).toEqual(["Get-Location\r"]);
    expect((await h.decide(proposal.id)).status).toBe(200);
    await h.decide(proposal.id);
    expect(h.pty.writes).toEqual(["Get-Location\r", "Get-Date\r"]);
    expect((await h.recheck(proposal.id)).status).toBe(409);
  });

  it("refuses target substitution, missing leases and a changed directory", async () => {
    const h = await setup();
    await h.completeFirst();
    await h.decide(h.second.id);
    expect((await h.recheck(h.second.id, { command: "other", terminalSessionId: h.first.terminalSessionId })).status).toBe(400);
    const otherOwner = await h.authenticate();
    expect(await (await h.recheck(h.second.id, {}, otherOwner)).json()).toEqual({ error: "write_lease_required" });
    h.emit({ type: "prompt", ...h.source, cwd: "C:\\other" });
    expect(await (await h.recheck(h.second.id)).json()).toEqual({ error: "proposal_target_changed" });
    expect(h.pty.writes).toEqual(["Get-Location\r"]);
    expect((await h.snapshot()).proposals).toHaveLength(2);
  });

  it("waits for an idle empty original shell and revalidates again at final approval", async () => {
    const h = await setup();
    await h.completeFirst();
    await h.decide(h.second.id);
    h.emit({ type: "commandStart", command: "long-running", ...h.source });
    expect(await (await h.recheck(h.second.id)).json()).toEqual({ error: "proposal_terminal_not_ready" });
    h.emit({ type: "commandEnd", cwd: h.source.cwd, exitCode: 0 });
    h.emit({ type: "prompt", ...h.source });
    const { proposal } = await (await h.recheck(h.second.id)).json() as { proposal: CommandProposal };
    h.emit({ type: "prompt", ...h.source, cwd: "C:\\other" });
    expect((await h.decide(proposal.id)).status).toBe(409);
    expect(h.pty.writes).toEqual(["Get-Location\r"]);
    expect((await h.snapshot()).proposals.at(-1)?.status).toBe("stale");
  });

  it("does not recheck into a nonempty input line or a destroyed terminal", async () => {
    const h = await setup();
    await h.completeFirst();
    await h.decide(h.second.id);
    await h.typeInput("manual text");
    expect(await (await h.recheck(h.second.id)).json()).toEqual({ error: "proposal_terminal_not_ready" });
    expect((await h.closeTerminal()).status).toBe(204);
    expect(await (await h.recheck(h.second.id)).json()).toEqual({ error: "proposal_target_unavailable" });
    expect(h.pty.writes).toEqual(["Get-Location\r", "manual text"]);
  });

  it("refuses a different environment frame even when its label looks identical", async () => {
    const h = await setup();
    await h.completeFirst(); await h.decide(h.second.id);
    h.emit({ type: "environmentPush", kind: "ssh", label: "Local Windows", host: "different-host" });
    h.emit({ type: "prompt", ...h.source });
    expect(await (await h.recheck(h.second.id)).json()).toEqual({ error: "proposal_target_changed" });
    expect(h.pty.writes).toEqual(["Get-Location\r"]);
  });

  it("renews an expired proposal once and keeps submitted, inserted and rejected suggestions closed", async () => {
    let now = new Date("2026-09-23T00:00:00Z");
    const h = await setup(() => now);
    now = new Date("2026-09-23T00:06:00Z");
    expect(await (await h.decide(h.second.id)).json()).toEqual({ error: "proposal_expired" });
    const checks = await Promise.all([h.recheck(h.second.id), h.recheck(h.second.id)]);
    const [one, two] = await Promise.all(checks.map((response) => response.json())) as Array<{ proposal: CommandProposal }>;
    expect(one!.proposal.id).toBe(two!.proposal.id);
    expect(one!.proposal.expiresAt).toBe("2026-09-23T00:11:00.000Z");
    expect((await h.post(`/v1/approvals/${one!.proposal.id}/decision`, { decision: "insert" })).status).toBe(200);
    expect((await h.recheck(one!.proposal.id)).status).toBe(409);
    h.emit({ type: "prompt", ...h.source });
    await h.decide(h.first.id);
    const { proposal } = await (await h.recheck(h.first.id)).json() as { proposal: CommandProposal };
    await h.post(`/v1/approvals/${proposal.id}/decision`, { decision: "reject" });
    expect((await h.recheck(proposal.id)).status).toBe(409);
    expect(h.pty.writes).toEqual(["Get-Date"]);
  });

  it("restores the replacement chain from SQLite without restoring execution authority", async () => {
    directory = mkdtempSync(join(tmpdir(), "stackbridge-recheck-"));
    store = new WorkspaceStore(directory);
    const h = await setup();
    await h.completeFirst();
    await h.decide(h.second.id);
    const { proposal } = await (await h.recheck(h.second.id)).json() as { proposal: CommandProposal };
    for (const socket of sockets.splice(0)) await new Promise<void>((resolve) => { socket.once("close", resolve); socket.close(); });
    await core.close(); store.close();
    store = new WorkspaceStore(directory);
    const restored = new ConversationService(new TerminalSessionManager(() => new ControlledPty()), {
      async startSession() { return "unused"; }, async runTurn() { throw new Error("No model call expected"); },
    }, undefined, store);
    core = createCoreServer({ allowedOrigins: [origin], terminalSessions: new TerminalSessionManager(() => new ControlledPty()), conversations: restored });
    await core.listen({ host: "127.0.0.1", port: 0 });
    const address = core.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const base = `http://127.0.0.1:${address.port}`;
    const auth = await fetch(`${base}/v1/auth/session`, { method: "POST", headers: { origin } });
    const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
    const result = await fetch(`${base}/v1/conversations/${proposal.conversationId}`, { headers: { cookie } });
    const snapshot = await result.json() as ConversationSnapshot;
    expect(snapshot.proposals).toHaveLength(3);
    expect(snapshot.proposals.find((item) => item.id === h.second.id)?.replacementProposalId).toBe(proposal.id);
    expect(snapshot.proposals.find((item) => item.id === proposal.id)).toMatchObject({ replacesProposalId: h.second.id, status: "pending" });
    const response = await fetch(`${base}/v1/approvals/${proposal.id}/recheck`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(409);
  });
});
