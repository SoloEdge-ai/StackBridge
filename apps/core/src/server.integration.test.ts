import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createCoreServer, type CoreServer } from "./server.js";
import { TerminalSessionManager } from "./terminal-session.js";
import { ControlledPty } from "./test/controlled-pty.js";

const origin = "http://127.0.0.1:5173";
const firstMessages = new WeakMap<WebSocket, Promise<unknown>>();

describe("Core browser boundary", () => {
  let core: CoreServer | undefined;

  afterEach(async () => {
    await core?.close();
  });

  it("requires an allowed origin and a valid launch token", async () => {
    const pty = new ControlledPty();
    core = createCoreServer({
      launchToken: "launch-secret",
      allowedOrigins: [origin],
      terminalSessions: new TerminalSessionManager(() => pty),
    });
    const baseUrl = await listen(core);

    const wrongOrigin = await fetch(`${baseUrl}/v1/auth/session`, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        authorization: "Bearer launch-secret",
      },
    });
    const wrongToken = await fetch(`${baseUrl}/v1/auth/session`, {
      method: "POST",
      headers: {
        origin,
        authorization: "Bearer wrong",
      },
    });

    expect(wrongOrigin.status).toBe(403);
    expect(wrongToken.status).toBe(401);
  });

  it("creates a terminal and reconnects to the same session over WebSocket", async () => {
    const pty = new ControlledPty();
    core = createCoreServer({
      launchToken: "launch-secret",
      allowedOrigins: [origin],
      terminalSessions: new TerminalSessionManager(() => pty),
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

  it("rejects WebSocket upgrades without the allowed origin and cookie", async () => {
    const pty = new ControlledPty();
    core = createCoreServer({
      launchToken: "launch-secret",
      allowedOrigins: [origin],
      terminalSessions: new TerminalSessionManager(() => pty),
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

  async function authenticate(baseUrl: string): Promise<string> {
    const response = await fetch(`${baseUrl}/v1/auth/session`, {
      method: "POST",
      headers: {
        origin,
        authorization: "Bearer launch-secret",
      },
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
