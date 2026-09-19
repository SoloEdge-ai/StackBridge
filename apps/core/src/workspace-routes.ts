import type { IncomingMessage, ServerResponse } from "node:http";

import {
  approvalDecisionRequestSchema,
  createConversationRequestSchema,
  createTurnRequestSchema,
} from "@stackbridge/protocol";

import { BrowserSessionStore } from "./browser-session-store.js";
import { authenticatedBrowserSession } from "./browser-auth.js";
import type { CodexAppServer } from "./codex-app-server.js";
import {
  ConversationNotFoundError,
  ConversationService,
  ConversationTerminalNotFoundError,
  ProposalExpiredError,
  ProposalNotFoundError,
} from "./conversation-service.js";
import { readJsonBody, writeJson } from "./http.js";
import type { RemoteSessionService } from "./remote-session-manager.js";
import type { TerminalSessionManager } from "./terminal-session.js";
import { TerminalWebSocketHub } from "./terminal-websocket.js";

export interface WorkspaceRouteOptions {
  terminalSessions: TerminalSessionManager;
  remoteSessions?: Pick<RemoteSessionService, "close">;
  conversations?: ConversationService;
  ai?: Pick<
    CodexAppServer,
    "accountStatus" | "startLogin" | "cancelLogin" | "logout" | "models"
  >;
}

export async function handleWorkspaceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: WorkspaceRouteOptions,
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
