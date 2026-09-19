export type ConnectionState = "connecting" | "running" | "exited" | "unavailable";

export interface TerminalEnvironment {
  id: string;
  kind: "local" | "ssh" | "docker";
  label: string;
  verified: boolean;
  bindingId?: string;
  host?: string;
  containerId?: string;
}

export interface TerminalContext {
  terminalSessionId: string;
  contextVersion: number;
  shellState: "idle" | "running" | "foreground" | "unknown";
  inputEmpty: boolean;
  cwd: string;
  shell: string;
  user: string;
  environment: TerminalEnvironment;
  environmentStack: TerminalEnvironment[];
  recentCommandIds: string[];
}

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
