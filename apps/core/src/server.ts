import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createTerminalSessionRequestSchema,
  type TerminalSessionSnapshot,
} from "@stackbridge/protocol";
import { WebSocketServer } from "ws";
import { ZodError } from "zod";

import { BrowserSessionStore } from "./browser-session-store.js";
import {
  InvalidDeploymentApprovalError,
  RemoteDeploymentApprovalRequiredError,
  RemoteSessionLimitError,
  RemoteSessionNotFoundError,
  type RemoteSessionService,
} from "./remote-session-manager.js";
import {
  TerminalSessionLimitError,
  type TerminalSessionManager,
} from "./terminal-session.js";
import { TerminalWebSocketHub } from "./terminal-websocket.js";

const sessionCookieName = "stackbridge_session";
const maximumBodyBytes = 16_384;

export interface CoreServerOptions {
  launchToken: string;
  allowedOrigins: string[];
  terminalSessions: TerminalSessionManager;
  browserSessions?: BrowserSessionStore;
  remoteSessions?: RemoteSessionService;
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
  const browserSessions = options.browserSessions ?? new BrowserSessionStore();
  const allowedOrigins = new Set(options.allowedOrigins);
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 65_536 });
  const terminalWebSockets = new TerminalWebSocketHub();
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
      terminalWebSockets.attach(webSocket, terminalSession);
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
      const browserSession = browserSessions.issue();
      response.writeHead(204, {
        "set-cookie": `${sessionCookieName}=${browserSession}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${browserSessions.cookieMaxAgeSeconds()}`,
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
      let terminalSession;
      try {
        terminalSession = options.terminalSessions.create(parsed.data);
      } catch (error) {
        if (error instanceof TerminalSessionLimitError) {
          writeJson(response, 503, { error: "terminal_session_limit_reached" });
          return;
        }
        throw error;
      }
      const responseBody = terminalSession.snapshot() satisfies TerminalSessionSnapshot;
      writeJson(response, 201, responseBody);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/remote-sessions") {
      if (options.remoteSessions === undefined) {
        writeJson(response, 503, { error: "remote_sessions_unavailable" });
        return;
      }
      try {
        const snapshot = await options.remoteSessions.connect(await readJsonBody(request));
        writeJson(response, 201, snapshot);
      } catch (error) {
        if (error instanceof RemoteDeploymentApprovalRequiredError) {
          writeJson(response, 409, {
            error: "deployment_approval_required",
            approvalId: error.approvalId,
            proposal: error.proposal,
          });
        } else if (error instanceof InvalidDeploymentApprovalError) {
          writeJson(response, 409, { error: "deployment_approval_invalid" });
        } else if (error instanceof RemoteSessionLimitError) {
          writeJson(response, 503, { error: "remote_session_limit_reached" });
        } else if (error instanceof ZodError) {
          writeJson(response, 400, { error: "invalid_request" });
        } else {
          throw error;
        }
      }
      return;
    }

    const remoteSessionMatch = /^\/v1\/remote-sessions\/([0-9a-f-]{36})$/.exec(
      url.pathname,
    );
    if (request.method === "DELETE" && remoteSessionMatch?.[1]) {
      if (options.remoteSessions === undefined) {
        writeJson(response, 503, { error: "remote_sessions_unavailable" });
        return;
      }
      const closed = options.remoteSessions.close(remoteSessionMatch[1]);
      writeJson(response, closed ? 200 : 404, { closed });
      return;
    }

    const remoteExecuteMatch = /^\/v1\/remote-sessions\/([0-9a-f-]{36})\/manual-execute$/.exec(
      url.pathname,
    );
    if (request.method === "POST" && remoteExecuteMatch?.[1]) {
      if (options.remoteSessions === undefined) {
        writeJson(response, 503, { error: "remote_sessions_unavailable" });
        return;
      }
      try {
        const result = await options.remoteSessions.execute(
          remoteExecuteMatch[1],
          await readJsonBody(request),
        );
        writeJson(response, 200, result);
      } catch (error) {
        if (error instanceof RemoteSessionNotFoundError) {
          writeJson(response, 404, { error: "remote_session_not_found" });
        } else if (error instanceof ZodError) {
          writeJson(response, 400, { error: "invalid_request" });
        } else {
          throw error;
        }
      }
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
      options.remoteSessions?.disposeAll();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
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
  browserSessions: BrowserSessionStore,
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
