import {
  clientTerminalMessageSchema,
  type ServerTerminalMessage,
} from "@stackbridge/protocol";
import { WebSocket } from "ws";

import type { TerminalSession } from "./terminal-session.js";

const defaultMaximumBufferedBytes = 2_097_152;

interface SessionConnections {
  sockets: WebSocket[];
  writer: WebSocket | undefined;
}

export class TerminalWebSocketHub {
  private readonly sessions = new Map<string, SessionConnections>();
  private readonly owners = new WeakMap<WebSocket, string>();

  constructor(
    private readonly maximumBufferedBytes = defaultMaximumBufferedBytes,
  ) {}

  attach(webSocket: WebSocket, terminalSession: TerminalSession, owner: string): void {
    const connections = this.sessions.get(terminalSession.id) ?? {
      sockets: [],
      writer: undefined,
    };
    this.sessions.set(terminalSession.id, connections);
    this.owners.set(webSocket, owner);

    connections.sockets.push(webSocket);
    connections.writer ??= webSocket;

    const attachment = terminalSession.attach((event) => {
      this.send(webSocket, event);
    });
    const snapshot = attachment.snapshot;
    this.send(webSocket, {
      type: "ready",
      sessionId: snapshot.id,
      state: snapshot.state,
      cols: snapshot.cols,
      rows: snapshot.rows,
      replay: snapshot.replay,
      writable:
        snapshot.state === "running" && connections.writer === webSocket,
    });

    webSocket.on("message", (raw, isBinary) => {
      if (isBinary) {
        this.sendError(
          webSocket,
          "binary_message_rejected",
          "Terminal control messages must be JSON text.",
        );
        return;
      }

      let body: unknown;
      try {
        body = JSON.parse(raw.toString());
      } catch {
        this.sendError(
          webSocket,
          "invalid_json",
          "Terminal message is not valid JSON.",
        );
        return;
      }

      const parsed = clientTerminalMessageSchema.safeParse(body);
      if (!parsed.success) {
        this.sendError(
          webSocket,
          "invalid_message",
          "Terminal message does not match the protocol.",
        );
        return;
      }

      if (parsed.data.type === "acquireWriteLease") {
        if (terminalSession.snapshot().state !== "running") {
          this.sendError(
            webSocket,
            "terminal_exited",
            "The terminal session has exited.",
          );
          return;
        }
        if (connections.writer !== webSocket) {
          if (connections.writer !== undefined) {
            this.send(connections.writer, { type: "writable", writable: false });
          }
          connections.writer = webSocket;
        }
        this.send(webSocket, { type: "writable", writable: true });
        return;
      }

      if (connections.writer !== webSocket) {
        this.sendError(
          webSocket,
          "write_lease_required",
          "Another client holds the terminal write lease.",
        );
        return;
      }

      try {
        if (parsed.data.type === "input") terminalSession.write(parsed.data.data);
        else terminalSession.resize(parsed.data.cols, parsed.data.rows);
      } catch {
        this.sendError(
          webSocket,
          "terminal_exited",
          "The terminal session has exited.",
        );
      }
    });

    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      attachment.detach();
      const index = connections.sockets.indexOf(webSocket);
      if (index >= 0) connections.sockets.splice(index, 1);

      if (connections.writer === webSocket) {
        connections.writer = connections.sockets.at(-1);
        if (connections.writer !== undefined) {
          this.send(connections.writer, { type: "writable", writable: true });
        }
      }
      if (connections.sockets.length === 0) {
        this.sessions.delete(terminalSession.id);
      }
    };
    webSocket.once("close", detach);
    webSocket.once("error", detach);
  }

  hasWriteLease(terminalSessionId: string, owner: string): boolean {
    const writer = this.sessions.get(terminalSessionId)?.writer;
    return writer !== undefined && this.owners.get(writer) === owner;
  }

  closeSession(terminalSessionId: string): void {
    const connections = this.sessions.get(terminalSessionId);
    if (connections === undefined) return;
    this.sessions.delete(terminalSessionId);
    for (const socket of [...connections.sockets]) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "Terminal session closed");
      } else socket.terminate();
    }
  }

  private sendError(webSocket: WebSocket, code: string, message: string): void {
    this.send(webSocket, { type: "error", code, message });
  }

  private send(webSocket: WebSocket, message: ServerTerminalMessage): void {
    if (webSocket.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(message);
    if (
      webSocket.bufferedAmount + Buffer.byteLength(payload, "utf8") >
      this.maximumBufferedBytes
    ) {
      webSocket.close(1013, "Terminal output buffer exceeded");
      return;
    }
    webSocket.send(payload);
  }
}
