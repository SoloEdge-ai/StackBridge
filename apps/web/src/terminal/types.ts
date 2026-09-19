import type { TerminalContext } from "@stackbridge/protocol";

export type { TerminalContext, TerminalEnvironment } from "@stackbridge/protocol";

export type ConnectionState = "connecting" | "running" | "exited" | "unavailable";

export interface TerminalCursorAnchor {
  getCursorRect(): DOMRect | undefined;
  observe(listener: () => void): () => void;
}

export interface PaneRuntimeState {
  context?: TerminalContext;
  connectionState: ConnectionState;
  writable: boolean;
  detail: string;
}

export function connectingRuntime(detail = "Attaching terminal…"): PaneRuntimeState {
  return { connectionState: "connecting", writable: false, detail };
}
