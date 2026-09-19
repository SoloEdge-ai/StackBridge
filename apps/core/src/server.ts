import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, relative, resolve } from "node:path";

import {
  createTerminalSessionRequestSchema,
  type TerminalSessionSnapshot,
} from "@stackbridge/protocol";
import { WebSocketServer } from "ws";
import { ZodError } from "zod";

import { BrowserSessionStore } from "./browser-session-store.js";
import {
  authenticatedBrowserSession,
  browserSessionCookieName,
} from "./browser-auth.js";
import type { CodexAppServer } from "./codex-app-server.js";
import type { ConversationService } from "./conversation-service.js";
import { isRecord, readJsonBody, writeJson } from "./http.js";
import {
  InvalidDeploymentApprovalError,
  RemoteDeploymentApprovalRequiredError,
  RemoteSessionLimitError,
  RemoteSessionNotFoundError,
  type RemoteSessionService,
} from "./remote-session-manager.js";
import type { RemotePtyLaunch } from "./remote-pty.js";
import {
  TerminalSessionLimitError,
  type TerminalSessionManager,
} from "./terminal-session.js";
import { TerminalWebSocketHub } from "./terminal-websocket.js";
import { handleWorkspaceRequest } from "./workspace-routes.js";

export interface CoreServerOptions {
  allowedOrigins: string[];
  terminalSessions: TerminalSessionManager;
  staticDirectory?: string;
  browserSessions?: BrowserSessionStore;
  remoteSessions?: RemoteSessionService;
  remotePtyLauncher?: (
    request: Extract<
      ReturnType<typeof createTerminalSessionRequestSchema.parse>,
      { kind: "ssh" | "docker" }
    >,
    snapshot: Awaited<ReturnType<RemoteSessionService["connect"]>>,
  ) => Promise<RemotePtyLaunch>;
  conversations?: ConversationService;
  ai?: Pick<
    CodexAppServer,
    "accountStatus" | "startLogin" | "cancelLogin" | "logout" | "models" | "close"
  >;
  settings?: {
    loadLocale(): "en" | "zh-CN";
    saveLocale(locale: "en" | "zh-CN"): void;
  };
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
  const remoteSessionByTerminal = new Map<string, string>();
  const server = createServer((request, response) => {
    void handleHttpRequest(request, response).catch((error: unknown) => {
      console.error("Core request failed", error);
      writeJson(response, 500, { error: "internal_error" });
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const browserSession = authenticatedBrowserSession(request, browserSessions);
    const rejection = validateBrowserRequest(request, allowedOrigins, true);
    if (rejection !== undefined || browserSession === undefined) {
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
      terminalWebSockets.attach(webSocket, terminalSession, browserSession);
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
      const browserSession = browserSessions.issue();
      response.writeHead(204, {
        "set-cookie": `${browserSessionCookieName}=${browserSession}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${browserSessions.cookieMaxAgeSeconds()}`,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }

    if (
      options.staticDirectory !== undefined &&
      (request.method === "GET" || request.method === "HEAD") &&
      !url.pathname.startsWith("/v1/") &&
      await serveStaticWorkbench(request, response, url, options.staticDirectory)
    ) return;

    if (!isAuthenticated(request, browserSessions)) {
      writeJson(response, 401, { error: "authentication_required" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/auth/status") {
      writeJson(response, 200, { authenticated: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/settings") {
      writeJson(response, 200, { locale: options.settings?.loadLocale() ?? "en" });
      return;
    }

    if (request.method === "PUT" && url.pathname === "/v1/settings") {
      const body = await readJsonBody(request);
      if (!isRecord(body) || (body.locale !== "en" && body.locale !== "zh-CN")) {
        writeJson(response, 400, { error: "invalid_request" });
        return;
      }
      options.settings?.saveLocale(body.locale);
      writeJson(response, 200, { locale: body.locale });
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
        if (parsed.data.kind === "ssh" || parsed.data.kind === "docker") {
          if (options.remoteSessions === undefined || options.remotePtyLauncher === undefined) {
            writeJson(response, 503, { error: "remote_terminals_unavailable" });
            return;
          }
          const remoteRequest = parsed.data.kind === "ssh"
            ? {
                host: parsed.data.host,
                port: parsed.data.port,
                user: parsed.data.user,
                ...(parsed.data.deploymentApprovalId === undefined
                  ? {}
                  : { deploymentApprovalId: parsed.data.deploymentApprovalId }),
              }
            : {
                host: parsed.data.host,
                port: parsed.data.port,
                user: parsed.data.user,
                ...(parsed.data.deploymentApprovalId === undefined
                  ? {}
                  : { deploymentApprovalId: parsed.data.deploymentApprovalId }),
                docker: {
                  contextName: parsed.data.contextName,
                  selector: parsed.data.container,
                  requestedUser: parsed.data.containerUser,
                  cwd: parsed.data.cwd,
                },
              };
          const remoteSnapshot = await options.remoteSessions.connect(remoteRequest);
          try {
            const launch = await options.remotePtyLauncher(parsed.data, remoteSnapshot);
            terminalSession = options.terminalSessions.createFromPty(
              parsed.data,
              launch.pty,
              launch.initialContext,
            );
            remoteSessionByTerminal.set(terminalSession.id, remoteSnapshot.sessionId);
          } catch (error) {
            options.remoteSessions.close(remoteSnapshot.sessionId);
            throw error;
          }
        } else terminalSession = options.terminalSessions.create(parsed.data);
      } catch (error) {
        if (error instanceof TerminalSessionLimitError) {
          writeJson(response, 503, { error: "terminal_session_limit_reached" });
          return;
        }
        if (error instanceof RemoteDeploymentApprovalRequiredError) {
          writeJson(response, 409, {
            error: "deployment_approval_required",
            approvalId: error.approvalId,
            proposal: error.proposal,
          });
          return;
        }
        if (error instanceof InvalidDeploymentApprovalError) {
          writeJson(response, 409, { error: "deployment_approval_invalid" });
          return;
        }
        if (error instanceof RemoteSessionLimitError) {
          writeJson(response, 503, { error: "remote_session_limit_reached" });
          return;
        }
        if (error instanceof ZodError) {
          writeJson(response, 400, { error: "invalid_request" });
          return;
        }
        throw error;
      }
      const responseBody = terminalSession.snapshot() satisfies TerminalSessionSnapshot;
      writeJson(response, 201, responseBody);
      return;
    }

    if (
      await handleWorkspaceRequest(
        request,
        response,
        url,
        options,
        browserSessions,
        terminalWebSockets,
        remoteSessionByTerminal,
      )
    ) return;

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
      options.ai?.close();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

async function serveStaticWorkbench(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  staticDirectory: string,
): Promise<boolean> {
  const root = resolve(staticDirectory);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    writeText(response, 400, "Invalid URL path");
    return true;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const requestedPath = resolve(root, relativePath);
  const fromRoot = relative(root, requestedPath);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot) || pathname.includes("\0")) {
    writeText(response, 404, "Not found");
    return true;
  }

  let filePath = requestedPath;
  if (!await isRegularFile(filePath)) {
    if (extname(pathname) !== "") {
      writeText(response, 404, "Not found");
      return true;
    }
    filePath = resolve(root, "index.html");
    if (!await isRegularFile(filePath)) {
      writeText(response, 404, "Not found");
      return true;
    }
  }

  const body = await readFile(filePath);
  response.writeHead(200, {
    "content-type": contentType(filePath),
    "content-length": String(body.byteLength),
    "cache-control": filePath === resolve(root, "index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "x-content-type-options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function contentType(path: string): string {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function writeText(response: ServerResponse, status: number, body: string): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
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

function isAuthenticated(
  request: IncomingMessage,
  browserSessions: BrowserSessionStore,
): boolean {
  return authenticatedBrowserSession(request, browserSessions) !== undefined;
}
