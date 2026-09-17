import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  clientTerminalMessageSchema,
  createTerminalSessionRequestSchema,
  type ServerTerminalMessage,
} from "@stackbridge/protocol";
import { WebSocket, WebSocketServer } from "ws";

import type { TerminalSessionManager } from "./terminal-session.js";

const sessionCookieName = "stackbridge_session";
const maximumBodyBytes = 16_384;

export interface CoreServerOptions {
  launchToken: string;
  allowedOrigins: string[];
  terminalSessions: TerminalSessionManager;
}

export interface ListenOptions {
  host: string;
  port: number;
}

export interface CoreServer {
  listen(options: ListenOptions): Promise<void>;
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}

export function createCoreServer(options: CoreServerOptions): CoreServer {
  const browserSessions = new Set<string>();
  const allowedOrigins = new Set(options.allowedOrigins);
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 65_536 });
  const server = createServer((request, response) => {
    void handleHttpRequest(request, response).catch((error: unknown) => {
      console.error("Core request failed", error);
      writeJson(response, 500, { error: "internal_error" });
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const rejection = validateBrowserRequest(request, allowedOrigins, true);
    if (rejection !== undefined || !isAuthenticated(request, browserSessions)) {
      socket.write(
        `HTTP/1.1 ${rejection ?? 401} ${rejection === 403 ? "Forbidden" : "Unauthorized"}\r\nConnection: close\r\n\r\n`,
      );
      socket.destroy();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/v1\/terminal-sessions\/([0-9a-f-]{36})\/stream$/.exec(
      url.pathname,
    );
    const terminalSession = match?.[1]
      ? options.terminalSessions.get(match[1])
      : undefined;
    if (terminalSession === undefined) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      attachTerminalWebSocket(webSocket, terminalSession);
    });
  });

  async function handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const rejection = validateBrowserRequest(
      request,
      allowedOrigins,
      request.method !== "GET" && request.method !== "HEAD",
    );
    if (rejection !== undefined) {
      writeJson(response, rejection, { error: "request_rejected" });
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST" && url.pathname === "/v1/auth/session") {
      if (!validBearerToken(request, options.launchToken)) {
        writeJson(response, 401, { error: "invalid_launch_token" });
        return;
      }
      const browserSession = randomBytes(32).toString("base64url");
      browserSessions.add(browserSession);
      response.writeHead(204, {
        "set-cookie": `${sessionCookieName}=${browserSession}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }

    if (!isAuthenticated(request, browserSessions)) {
      writeJson(response, 401, { error: "authentication_required" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/auth/status") {
      writeJson(response, 200, { authenticated: true });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/terminal-sessions"
    ) {
      const body = await readJsonBody(request);
      const parsed = createTerminalSessionRequestSchema.safeParse(body);
      if (!parsed.success) {
        writeJson(response, 400, { error: "invalid_request" });
        return;
      }
      const terminalSession = options.terminalSessions.create(parsed.data);
      writeJson(response, 201, terminalSession.snapshot());
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  }

  return {
    listen: async ({ host, port }) => {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          resolve();
        });
      });
    },
    address: () => server.address(),
    close: async () => {
      for (const webSocket of webSockets.clients) webSocket.terminate();
      webSockets.close();
      options.terminalSessions.disposeAll();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

function attachTerminalWebSocket(
  webSocket: WebSocket,
  terminalSession: NonNullable<ReturnType<TerminalSessionManager["get"]>>,
): void {
  const attachment = terminalSession.attach((event) => {
    sendJson(webSocket, event);
  });
  const snapshot = attachment.snapshot;
  sendJson(webSocket, {
    type: "ready",
    sessionId: snapshot.id,
    state: snapshot.state,
    cols: snapshot.cols,
    rows: snapshot.rows,
    replay: snapshot.replay,
    writable: snapshot.state === "running",
  });

  webSocket.on("message", (raw, isBinary) => {
    if (isBinary) {
      sendJson(webSocket, {
        type: "error",
        code: "binary_message_rejected",
        message: "Terminal control messages must be JSON text.",
      });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.toString());
    } catch {
      sendJson(webSocket, {
        type: "error",
        code: "invalid_json",
        message: "Terminal message is not valid JSON.",
      });
      return;
    }

    const parsed = clientTerminalMessageSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(webSocket, {
        type: "error",
        code: "invalid_message",
        message: "Terminal message does not match the protocol.",
      });
      return;
    }

    try {
      if (parsed.data.type === "input") terminalSession.write(parsed.data.data);
      else terminalSession.resize(parsed.data.cols, parsed.data.rows);
    } catch {
      sendJson(webSocket, {
        type: "error",
        code: "terminal_exited",
        message: "The terminal session has exited.",
      });
    }
  });
  webSocket.once("close", attachment.detach);
  webSocket.once("error", attachment.detach);
}

function validateBrowserRequest(
  request: IncomingMessage,
  allowedOrigins: Set<string>,
  requireOrigin: boolean,
): 400 | 403 | undefined {
  const host = request.headers.host;
  if (host === undefined || !isLoopbackHost(host)) return 400;

  const origin = request.headers.origin;
  if (requireOrigin && (origin === undefined || !allowedOrigins.has(origin))) {
    return 403;
  }
  if (origin !== undefined && !allowedOrigins.has(origin)) return 403;
  return undefined;
}

function isLoopbackHost(host: string): boolean {
  try {
    const parsed = new URL(`http://${host}`);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function validBearerToken(request: IncomingMessage, expected: string): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  const actualBuffer = Buffer.from(authorization.slice("Bearer ".length));
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function isAuthenticated(
  request: IncomingMessage,
  browserSessions: Set<string>,
): boolean {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader === undefined) return false;
  for (const cookie of cookieHeader.split(";")) {
    const [name, value] = cookie.trim().split("=", 2);
    if (name === sessionCookieName && value && browserSessions.has(value)) return true;
  }
  return false;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBodyBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendJson(webSocket: WebSocket, message: ServerTerminalMessage): void {
  if (webSocket.readyState === WebSocket.OPEN) {
    webSocket.send(JSON.stringify(message));
  }
}
