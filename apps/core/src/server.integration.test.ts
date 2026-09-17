import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { createCoreServer, type CoreServer } from "./server.js";
import { ConversationService, type TerminalAssistant } from "./conversation-service.js";
import {
  RemoteDeploymentApprovalRequiredError,
  type RemoteSessionService,
} from "./remote-session-manager.js";
import { TerminalSessionManager } from "./terminal-session.js";
import { ControlledPty } from "./test/controlled-pty.js";

const origin = "http://127.0.0.1:5173";
const firstMessages = new WeakMap<WebSocket, Promise<unknown>>();
const testIntegrationToken = "test-shell-integration-token";
const testManagerOptions = {
  shellIntegrationTokenFactory: () => testIntegrationToken,
};

describe("Core browser boundary", () => {
  let core: CoreServer | undefined;

  afterEach(async () => {
    await core?.close();
  });

  it("creates a browser session only for an allowed local origin", async () => {
    const pty = new ControlledPty();
    core = createCoreServer({
      allowedOrigins: [origin],
      terminalSessions: new TerminalSessionManager(() => pty, testManagerOptions),
    });
    const baseUrl = await listen(core);

    const wrongOrigin = await fetch(`${baseUrl}/v1/auth/session`, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
      },
    });
    const allowedOrigin = await fetch(`${baseUrl}/v1/auth/session`, {
      method: "POST",
      headers: { origin },
    });

    expect(wrongOrigin.status).toBe(403);
    expect(allowedOrigin.status).toBe(204);
    expect(allowedOrigin.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("creates a terminal and reconnects to the same session over WebSocket", async () => {
    const pty = new ControlledPty();
    core = createCoreServer({
      allowedOrigins: [origin],
      terminalSessions: new TerminalSessionManager(() => pty, testManagerOptions),
    });
    const baseUrl = await listen(core);
    const cookie = await authenticate(baseUrl);

    const createResponse = await fetch(`${baseUrl}/v1/terminal-sessions`, {
      method: "POST",
      headers: {
        origin,
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ cols: 100, rows: 30 }),
    });
    const created = (await createResponse.json()) as { id: string };

    expect(createResponse.status).toBe(201);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    const firstSocket = await connectWebSocket(baseUrl, created.id, cookie);
    const firstReady = await nextJsonMessage(firstSocket);
    expect(firstReady).toMatchObject({
      type: "ready",
      sessionId: created.id,
      state: "running",
      replay: "",
      writable: true,
    });

    const secondSocket = await connectWebSocket(baseUrl, created.id, cookie);
    expect(await nextJsonMessage(secondSocket)).toMatchObject({
      type: "ready",
      sessionId: created.id,
      writable: false,
    });

    const readOnlyError = nextJsonMessage(secondSocket);
    secondSocket.send(JSON.stringify({ type: "input", data: "blocked\r" }));
    expect(await readOnlyError).toMatchObject({
      type: "error",
      code: "write_lease_required",
    });
    expect(pty.writes).toEqual([]);

    const firstRevoked = nextJsonMessage(firstSocket);
    const secondGranted = nextJsonMessage(secondSocket);
    secondSocket.send(JSON.stringify({ type: "acquireWriteLease" }));
    expect(await firstRevoked).toEqual({ type: "writable", writable: false });
    expect(await secondGranted).toEqual({ type: "writable", writable: true });

    secondSocket.send(JSON.stringify({ type: "input", data: "pwd\r" }));
    secondSocket.send(JSON.stringify({ type: "resize", cols: 132, rows: 40 }));
    await eventually(() => pty.writes.length === 1 && pty.resizes.length === 1);
    expect(pty.writes).toEqual(["pwd\r"]);
    expect(pty.resizes).toEqual([{ cols: 132, rows: 40 }]);

    const firstPromoted = nextJsonMessage(firstSocket);
    await closeWebSocket(secondSocket);
    expect(await firstPromoted).toEqual({ type: "writable", writable: true });
    firstSocket.send(JSON.stringify({ type: "input", data: "whoami\r" }));
    await eventually(() => pty.writes.length === 2);
    expect(pty.writes).toEqual(["pwd\r", "whoami\r"]);

    await closeWebSocket(firstSocket);
    pty.emitData("output while browser is refreshing\r\n");

    const refreshedSocket = await connectWebSocket(baseUrl, created.id, cookie);
    const refreshedReady = await nextJsonMessage(refreshedSocket);
    expect(refreshedReady).toMatchObject({
      type: "ready",
      sessionId: created.id,
      replay: "output while browser is refreshing\r\n",
    });
    refreshedSocket.close();
  });

  it("closes a terminal session and releases its capacity", async () => {
    const firstPty = new ControlledPty();
    const secondPty = new ControlledPty();
    const kill = vi.spyOn(firstPty, "kill");
    const terminalSessions = new TerminalSessionManager(
      vi.fn()
        .mockReturnValueOnce(firstPty)
        .mockReturnValueOnce(secondPty),
      { ...testManagerOptions, maxSessions: 1 },
    );
    core = createCoreServer({ allowedOrigins: [origin], terminalSessions });
    const baseUrl = await listen(core);
    const cookie = await authenticate(baseUrl);
    const headers = { origin, cookie, "content-type": "application/json" };

    const first = await fetch(`${baseUrl}/v1/terminal-sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    const created = (await first.json()) as { id: string };

    const atCapacity = await fetch(`${baseUrl}/v1/terminal-sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    expect(atCapacity.status).toBe(503);

    const closed = await fetch(`${baseUrl}/v1/terminal-sessions/${created.id}`, {
      method: "DELETE",
      headers: { origin, cookie },
    });
    expect(closed.status).toBe(204);
    expect(kill).toHaveBeenCalledOnce();

    const replacement = await fetch(`${baseUrl}/v1/terminal-sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    expect(replacement.status).toBe(201);
  });

  it("closes the runtime management session with a remote terminal", async () => {
    const remoteSessionId = "11111111-1111-4111-8111-111111111111";
    const remotePty = new ControlledPty();
    const remoteSessions: RemoteSessionService = {
      connect: vi.fn(async () => ({
        schemaVersion: 2 as const,
        sessionId: remoteSessionId,
        bindingId: "33333333-3333-4333-8333-333333333333",
        targetKind: "ssh" as const,
        host: "friden-dev-cube",
        user: "friden",
        hostKeyFingerprint: "SHA256:test",
        runtimeVersion: "0.2.0-dev",
        runtimeDigest: `sha256:${"a".repeat(64)}`,
        runtimeInstanceId: "runtime.test",
        hostBootId: "boot.test",
        arch: "amd64",
        defaultCwd: "/home/friden",
        shell: "/bin/bash",
        deployment: "installed" as const,
      })),
      execute: vi.fn(),
      close: vi.fn(() => true),
      disposeAll: vi.fn(),
    };
    core = createCoreServer({
      allowedOrigins: [origin],
      terminalSessions: new TerminalSessionManager(
        () => new ControlledPty(),
        testManagerOptions,
      ),
      remoteSessions,
      remotePtyLauncher: vi.fn(async () => ({
        pty: remotePty,
        initialContext: {
          environments: [{
            id: "env.ssh",
            kind: "ssh" as const,
            label: "friden@friden-dev-cube",
            verified: true,
            bindingId: "33333333-3333-4333-8333-333333333333",
            host: "friden-dev-cube",
          }],
          cwd: "/home/friden",
          shell: "bash",
          user: "friden",
          shellState: "unknown" as const,
          shellIntegrationToken: testIntegrationToken,
        },
      })),
    });
    const baseUrl = await listen(core);
    const cookie = await authenticate(baseUrl);
    const created = await fetch(`${baseUrl}/v1/terminal-sessions`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "ssh",
        cols: 80,
        rows: 24,
        host: "friden-dev-cube",
        port: 22,
        user: "friden",
      }),
    });
    const terminal = (await created.json()) as { id: string };

    const closed = await fetch(`${baseUrl}/v1/terminal-sessions/${terminal.id}`, {
      method: "DELETE",
      headers: { origin, cookie },
    });

    expect(closed.status).toBe(204);
    expect(remoteSessions.close).toHaveBeenCalledWith(remoteSessionId);
  });

  it("rejects WebSocket upgrades without the allowed origin and cookie", async () => {
    const pty = new ControlledPty();
    core = createCoreServer({
      allowedOrigins: [origin],
      terminalSessions: new TerminalSessionManager(() => pty, testManagerOptions),
    });
    const baseUrl = await listen(core);
    const cookie = await authenticate(baseUrl);
    const createResponse = await fetch(`${baseUrl}/v1/terminal-sessions`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    const created = (await createResponse.json()) as { id: string };

    expect(
      await rejectedWebSocketStatus(baseUrl, created.id, {
        origin: "https://attacker.example",
        cookie,
      }),
    ).toBe(403);
    expect(
      await rejectedWebSocketStatus(baseUrl, created.id, { origin }),
    ).toBe(401);
  });

  it("requires deployment approval and then exposes remote argv execution", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const approvalId = "22222222-2222-4222-8222-222222222222";
    const proposal = {
      reason: "missing" as const,
      installRoot: "~/.sbridge" as const,
      runtimeVersion: "0.1.0",
      runtimeDigest: `sha256:${"a".repeat(64)}`,
      platform: "linux" as const,
      arch: "amd64" as const,
      user: "friden",
      host: "friden-dev-cube",
      hostKeyFingerprint: "SHA256:test",
      permissions: "0700 directories, 0755 runtime" as const,
      cleanup: "Disconnect StackBridge, then remove ~/.sbridge" as const,
    };
    const remoteSessions: RemoteSessionService = {
      connect: vi.fn(async (input: unknown) => {
        const request = input as { deploymentApprovalId?: string };
        if (request.deploymentApprovalId !== approvalId) {
          throw new RemoteDeploymentApprovalRequiredError(approvalId, proposal);
        }
        return {
          schemaVersion: 2 as const,
          sessionId,
          bindingId: "33333333-3333-4333-8333-333333333333",
          targetKind: "ssh" as const,
          host: "friden-dev-cube",
          user: "friden",
          hostKeyFingerprint: "SHA256:test",
          runtimeVersion: "0.1.0",
          runtimeDigest: `sha256:${"a".repeat(64)}`,
          runtimeInstanceId: "runtime.test",
          hostBootId: "boot.test",
          arch: "amd64",
          defaultCwd: "/home/friden",
          shell: "/bin/bash",
          deployment: "installed" as const,
        };
      }),
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "friden\n",
        stderr: "",
        timedOut: false,
      })),
      close: vi.fn(() => true),
      disposeAll: vi.fn(),
    };
    core = createCoreServer({
      allowedOrigins: [origin],
      terminalSessions: new TerminalSessionManager(
        () => new ControlledPty(),
        testManagerOptions,
      ),
      remoteSessions,
    });
    const baseUrl = await listen(core);
    const cookie = await authenticate(baseUrl);
    const request = {
      host: "friden-dev-cube",
      port: 22,
      user: "friden",
    };

    const pending = await fetch(`${baseUrl}/v1/remote-sessions`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toEqual({
      error: "deployment_approval_required",
      approvalId,
      proposal,
    });

    const connected = await fetch(`${baseUrl}/v1/remote-sessions`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ ...request, deploymentApprovalId: approvalId }),
    });
    expect(connected.status).toBe(201);
    expect(await connected.json()).toMatchObject({ sessionId, deployment: "installed" });

    const executed = await fetch(`${baseUrl}/v1/remote-sessions/${sessionId}/manual-execute`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({
        cwd: "/home/friden",
        program: "/usr/bin/id",
        args: ["-un"],
        timeoutMs: 15_000,
      }),
    });
    expect(executed.status).toBe(200);
    expect(await executed.json()).toMatchObject({ exitCode: 0, stdout: "friden\n" });
  });

  it("creates a continuous conversation and executes only the immutable approved proposal", async () => {
    const pty = new ControlledPty();
    const terminalSessions = new TerminalSessionManager(() => pty, testManagerOptions);
    const conversations = new ConversationService(
      terminalSessions,
      new HttpFakeAssistant(),
    );
    core = createCoreServer({
      allowedOrigins: [origin],
      terminalSessions,
      conversations,
    });
    const baseUrl = await listen(core);
    const cookie = await authenticate(baseUrl);
    const headers = { origin, cookie, "content-type": "application/json" };
    const terminalResponse = await fetch(`${baseUrl}/v1/terminal-sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cols: 100, rows: 30 }),
    });
    const terminal = (await terminalResponse.json()) as { id: string };
    pty.emitData(shellMarker({
      type: "prompt",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
    }));

    const conversationResponse = await fetch(`${baseUrl}/v1/conversations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ terminalSessionId: terminal.id, model: "gpt-test" }),
    });
    const conversation = (await conversationResponse.json()) as { id: string };
    expect(conversationResponse.status).toBe(201);

    const turnResponse = await fetch(
      `${baseUrl}/v1/conversations/${conversation.id}/turns`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          terminalSessionId: terminal.id,
          message: "怎么查看位置？",
        }),
      },
    );
    const turn = (await turnResponse.json()) as {
      proposals: Array<{ id: string; command: string }>;
    };
    expect(turnResponse.status).toBe(200);
    expect(turn.proposals[0]?.command).toBe("Get-Location");

    const forged = await fetch(
      `${baseUrl}/v1/approvals/${turn.proposals[0]!.id}/decision`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ decision: "execute", command: "Remove-Item *" }),
      },
    );
    expect(forged.status).toBe(400);
    expect(pty.writes).toEqual([]);

    const withoutLease = await fetch(
      `${baseUrl}/v1/approvals/${turn.proposals[0]!.id}/decision`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ decision: "execute" }),
      },
    );
    expect(withoutLease.status).toBe(409);
    expect(await withoutLease.json()).toEqual({ error: "write_lease_required" });
    expect(pty.writes).toEqual([]);

    const writer = await connectWebSocket(baseUrl, terminal.id, cookie);
    expect(await nextJsonMessage(writer)).toMatchObject({ writable: true });

    const approved = await fetch(
      `${baseUrl}/v1/approvals/${turn.proposals[0]!.id}/decision`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ decision: "execute" }),
      },
    );
    const approval = (await approved.json()) as { operation: { id: string } };
    expect(approved.status).toBe(200);
    expect(pty.writes).toEqual(["Get-Location\r"]);

    const repeated = await fetch(
      `${baseUrl}/v1/approvals/${turn.proposals[0]!.id}/decision`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ decision: "execute" }),
      },
    );
    expect((await repeated.json()) as { operation: { id: string } }).toMatchObject({
      operation: { id: approval.operation.id },
    });
    expect(pty.writes).toEqual(["Get-Location\r"]);
    await closeWebSocket(writer);
  });

  async function authenticate(baseUrl: string): Promise<string> {
    const response = await fetch(`${baseUrl}/v1/auth/session`, {
      method: "POST",
      headers: { origin },
    });
    expect(response.status).toBe(204);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    return setCookie!.split(";", 1)[0]!;
  }
});

async function listen(core: CoreServer): Promise<string> {
  await core.listen({ host: "127.0.0.1", port: 0 });
  const address = core.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

class HttpFakeAssistant implements TerminalAssistant {
  async createThread(): Promise<string> {
    return "thread-http";
  }

  async runTurn() {
    return {
      answer: "使用 Get-Location。",
      proposals: [{ purpose: "查看当前目录", command: "Get-Location" }],
    };
  }
}

function shellMarker(event: object): string {
  return `\u001b]777;stackbridge;${testIntegrationToken};${Buffer.from(JSON.stringify(event), "utf8").toString("base64url")}\u0007`;
}

async function connectWebSocket(
  baseUrl: string,
  sessionId: string,
  cookie: string,
): Promise<WebSocket> {
  const url = baseUrl
    .replace(/^http/, "ws")
    .concat(`/v1/terminal-sessions/${sessionId}/stream`);
  const socket = new WebSocket(url, { headers: { origin, cookie } });
  firstMessages.set(socket, waitForJsonMessage(socket));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function nextJsonMessage(socket: WebSocket): Promise<unknown> {
  const firstMessage = firstMessages.get(socket);
  if (firstMessage !== undefined) {
    firstMessages.delete(socket);
    return await firstMessage;
  }
  return await waitForJsonMessage(socket);
}

async function waitForJsonMessage(socket: WebSocket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  socket.close();
  await closed;
}

async function rejectedWebSocketStatus(
  baseUrl: string,
  sessionId: string,
  headers: Record<string, string>,
): Promise<number | undefined> {
  const url = baseUrl
    .replace(/^http/, "ws")
    .concat(`/v1/terminal-sessions/${sessionId}/stream`);
  const socket = new WebSocket(url, { headers });
  return await new Promise((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      response.destroy();
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("WebSocket upgrade unexpectedly succeeded"));
    });
    socket.once("error", reject);
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
