import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  approvalDecisionRequestSchema,
  createConversationRequestSchema,
  createTurnRequestSchema,
  createTerminalSessionRequestSchema,
  type TerminalSessionSnapshot,
} from "@stackbridge/protocol";
import { WebSocketServer } from "ws";
import { ZodError } from "zod";

import { BrowserSessionStore } from "./browser-session-store.js";
import type { CodexAppServer } from "./codex-app-server.js";
import {
  ConversationNotFoundError,
  ConversationService,
  ConversationTerminalNotFoundError,
  ProposalExpiredError,
  ProposalNotFoundError,
} from "./conversation-service.js";
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

const sessionCookieName = "stackbridge_session";
const maximumBodyBytes = 131_072;

export interface CoreServerOptions {
  allowedOrigins: string[];
  terminalSessions: TerminalSessionManager;
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

async function handleWorkspaceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: CoreServerOptions,
  browserSessions: BrowserSessionStore,
  terminalWebSockets: TerminalWebSocketHub,
  remoteSessionByTerminal: Map<string, string>,
): Promise<boolean> {
  const terminalMatch = /^\/v1\/terminal-sessions\/([0-9a-f-]{36})$/.exec(
    url.pathname,
  );
  if (request.method === "DELETE" && terminalMatch?.[1]) {
    const terminalSessionId = terminalMatch[1];
    if (options.terminalSessions.get(terminalSessionId) === undefined) {
      writeJson(response, 404, { error: "terminal_session_not_found" });
      return true;
    }
    terminalWebSockets.closeSession(terminalSessionId);
    options.terminalSessions.close(terminalSessionId);
    const remoteSessionId = remoteSessionByTerminal.get(terminalSessionId);
    remoteSessionByTerminal.delete(terminalSessionId);
    if (remoteSessionId !== undefined) options.remoteSessions?.close(remoteSessionId);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return true;
  }

  const contextMatch = /^\/v1\/terminal-sessions\/([0-9a-f-]{36})\/context$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && contextMatch?.[1]) {
    const terminal = options.terminalSessions.get(contextMatch[1]);
    if (terminal === undefined) {
      writeJson(response, 404, { error: "terminal_session_not_found" });
    } else writeJson(response, 200, terminal.context());
    return true;
  }

  const commandsMatch = /^\/v1\/terminal-sessions\/([0-9a-f-]{36})\/commands$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && commandsMatch?.[1]) {
    const terminal = options.terminalSessions.get(commandsMatch[1]);
    if (terminal === undefined) {
      writeJson(response, 404, { error: "terminal_session_not_found" });
    } else {
      const cursor = Math.max(0, Number(url.searchParams.get("cursor") ?? 0) || 0);
      const limit = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50),
      );
      const commands = terminal.commands();
      writeJson(response, 200, {
        data: commands.slice(cursor, cursor + limit),
        nextCursor: cursor + limit < commands.length ? cursor + limit : null,
      });
    }
    return true;
  }

  if (url.pathname === "/v1/conversations") {
    if (options.conversations === undefined) {
      writeJson(response, 503, { error: "conversations_unavailable" });
      return true;
    }
    if (request.method === "GET") {
      writeJson(response, 200, { data: options.conversations.list() });
      return true;
    }
    if (request.method === "POST") {
      const parsed = createConversationRequestSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) {
        writeJson(response, 400, { error: "invalid_request" });
        return true;
      }
      try {
        writeJson(response, 201, await options.conversations.create(parsed.data));
      } catch (error) {
        if (error instanceof ConversationTerminalNotFoundError) {
          writeJson(response, 404, { error: "terminal_session_not_found" });
        } else throw error;
      }
      return true;
    }
  }

  const conversationMatch = /^\/v1\/conversations\/([0-9a-f-]{36})$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && conversationMatch?.[1]) {
    if (options.conversations === undefined) {
      writeJson(response, 503, { error: "conversations_unavailable" });
      return true;
    }
    try {
      writeJson(response, 200, options.conversations.snapshot(conversationMatch[1]));
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        writeJson(response, 404, { error: "conversation_not_found" });
      } else throw error;
    }
    return true;
  }

  const turnMatch = /^\/v1\/conversations\/([0-9a-f-]{36})\/turns$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && turnMatch?.[1]) {
    if (options.conversations === undefined) {
      writeJson(response, 503, { error: "conversations_unavailable" });
      return true;
    }
    const parsed = createTurnRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      writeJson(response, 400, { error: "invalid_request" });
      return true;
    }
    try {
      writeJson(response, 200, await options.conversations.turn(turnMatch[1], parsed.data));
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        writeJson(response, 404, { error: "conversation_not_found" });
      } else if (error instanceof ConversationTerminalNotFoundError) {
        writeJson(response, 404, { error: "terminal_session_not_found" });
      } else throw error;
    }
    return true;
  }

  const stopMatch = /^\/v1\/conversations\/([0-9a-f-]{36})\/stop$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && stopMatch?.[1]) {
    if (options.conversations === undefined) {
      writeJson(response, 503, { error: "conversations_unavailable" });
      return true;
    }
    try {
      await options.conversations.stop(stopMatch[1]);
      writeJson(response, 200, { stopped: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        writeJson(response, 404, { error: "conversation_not_found" });
      } else throw error;
    }
    return true;
  }

  const approvalMatch = /^\/v1\/approvals\/([0-9a-f-]{36})\/decision$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && approvalMatch?.[1]) {
    if (options.conversations === undefined) {
      writeJson(response, 503, { error: "conversations_unavailable" });
      return true;
    }
    const parsed = approvalDecisionRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      writeJson(response, 400, { error: "invalid_request" });
      return true;
    }
    if (parsed.data.decision !== "reject") {
      try {
        const proposal = options.conversations.proposal(approvalMatch[1]);
        const owner = authenticatedBrowserSession(request, browserSessions);
        if (owner === undefined || !terminalWebSockets.hasWriteLease(proposal.terminalSessionId, owner)) {
          writeJson(response, 409, { error: "write_lease_required" });
          return true;
        }
      } catch (error) {
        if (error instanceof ProposalNotFoundError) {
          writeJson(response, 404, { error: "proposal_not_found" });
          return true;
        }
        throw error;
      }
    }
    try {
      writeJson(
        response,
        200,
        options.conversations.decide(approvalMatch[1], parsed.data.decision),
      );
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        writeJson(response, 404, { error: "proposal_not_found" });
      } else if (error instanceof ProposalExpiredError) {
        writeJson(response, 409, { error: "proposal_expired" });
      } else if (error instanceof ConversationTerminalNotFoundError) {
        writeJson(response, 409, { error: "proposal_target_unavailable" });
      } else if (error instanceof Error) {
        writeJson(response, 409, { error: "proposal_stale", message: error.message });
      } else throw error;
    }
    return true;
  }

  const operationMatch = /^\/v1\/operations\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (request.method === "GET" && operationMatch?.[1]) {
    const operation = options.conversations?.operation(operationMatch[1]);
    if (operation === undefined) {
      writeJson(response, 404, { error: "operation_not_found" });
    } else writeJson(response, 200, operation);
    return true;
  }

  if (url.pathname === "/v1/ai/account/status" && request.method === "GET") {
    if (options.ai === undefined) {
      writeJson(response, 503, { schemaVersion: 2, available: false, authenticated: false });
    } else writeJson(response, 200, await options.ai.accountStatus());
    return true;
  }
  if (url.pathname === "/v1/ai/account/login" && request.method === "POST") {
    if (options.ai === undefined) writeJson(response, 503, { error: "ai_unavailable" });
    else writeJson(response, 200, await options.ai.startLogin());
    return true;
  }
  if (url.pathname === "/v1/ai/account/login/cancel" && request.method === "POST") {
    if (options.ai === undefined) writeJson(response, 503, { error: "ai_unavailable" });
    else {
      const body = await readJsonBody(request);
      if (
        body === null ||
        typeof body !== "object" ||
        typeof (body as Record<string, unknown>).loginId !== "string"
      ) {
        writeJson(response, 400, { error: "invalid_request" });
      } else {
        await options.ai.cancelLogin((body as { loginId: string }).loginId);
        writeJson(response, 200, { cancelled: true });
      }
    }
    return true;
  }
  if (url.pathname === "/v1/ai/account/logout" && request.method === "POST") {
    if (options.ai === undefined) writeJson(response, 503, { error: "ai_unavailable" });
    else {
      await options.ai.logout();
      writeJson(response, 200, { loggedOut: true });
    }
    return true;
  }
  if (url.pathname === "/v1/ai/models" && request.method === "GET") {
    if (options.ai === undefined) writeJson(response, 503, { error: "ai_unavailable" });
    else writeJson(response, 200, { data: await options.ai.models() });
    return true;
  }

  return false;
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

function authenticatedBrowserSession(
  request: IncomingMessage,
  browserSessions: BrowserSessionStore,
): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader === undefined) return undefined;
  for (const cookie of cookieHeader.split(";")) {
    const [name, value] = cookie.trim().split("=", 2);
    if (name === sessionCookieName && value && browserSessions.has(value)) return value;
  }
  return undefined;
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
