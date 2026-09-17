import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  serverTerminalMessageSchema,
  terminalSessionSnapshotSchema,
} from "@stackbridge/protocol";

const storedSessionKey = "stackbridge.terminalSessionId";

type AuthState = "checking" | "required" | "authenticated";
type ConnectionState = "connecting" | "running" | "exited" | "unavailable";

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [workspaceKey, setWorkspaceKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetch("/v1/auth/status", { cache: "no-store" })
      .then((response) => {
        if (!cancelled) {
          setAuthState(response.ok ? "authenticated" : "required");
        }
      })
      .catch(() => {
        if (!cancelled) setAuthState("required");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const createFreshTerminal = useCallback(() => {
    sessionStorage.removeItem(storedSessionKey);
    setWorkspaceKey((key) => key + 1);
  }, []);

  if (authState === "checking") {
    return <CenteredStatus message="正在连接本地 StackBridge Core…" />;
  }

  if (authState === "required") {
    return <Login onAuthenticated={() => setAuthState("authenticated")} />;
  }

  return (
    <TerminalWorkspace
      key={workspaceKey}
      onAuthenticationLost={() => setAuthState("required")}
      onCreateFreshTerminal={createFreshTerminal}
    />
  );
}

function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch("/v1/auth/session", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("启动令牌无效或 Core 拒绝了请求。");
      setToken("");
      onAuthenticated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "认证失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark">SB</div>
        <p className="eyebrow">LOCAL CORE</p>
        <h1>连接 StackBridge</h1>
        <p className="muted">
          在运行 Core 的终端中复制启动令牌。令牌只用于换取 HttpOnly 本地会话，不会写入浏览器存储。
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="launch-token">启动令牌</label>
          <input
            id="launch-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          {error ? <p className="form-error">{error}</p> : null}
          <button type="submit" disabled={!token || submitting}>
            {submitting ? "正在验证…" : "进入本地终端"}
          </button>
        </form>
      </section>
    </main>
  );
}

function TerminalWorkspace({
  onAuthenticationLost,
  onCreateFreshTerminal,
}: {
  onAuthenticationLost: () => void;
  onCreateFreshTerminal: () => void;
}) {
  const terminalHost = useRef<HTMLDivElement>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [sessionId, setSessionId] = useState<string>();
  const [detail, setDetail] = useState("正在附着 PowerShell PTY");

  useEffect(() => {
    const host = terminalHost.current;
    if (host === null) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: {
        background: "#101314",
        foreground: "#d8e2dc",
        cursor: "#61e8b0",
        selectionBackground: "#315f50aa",
        black: "#1a1f20",
        green: "#61e8b0",
        brightGreen: "#8cf7c9",
        cyan: "#5bcad9",
        brightCyan: "#8de7ef",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminal.focus();

    let disposed = false;
    let terminalExited = false;
    let socket: WebSocket | undefined;
    const dataSubscription = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }),
        );
      }
    });
    resizeObserver.observe(host);

    void connect();

    async function connect() {
      try {
        const id =
          sessionStorage.getItem(storedSessionKey) ??
          (await createTerminalSession(terminal.cols, terminal.rows));
        if (disposed) return;
        sessionStorage.setItem(storedSessionKey, id);
        setSessionId(id);

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(
          `${protocol}//${window.location.host}/v1/terminal-sessions/${id}/stream`,
        );
        socket.addEventListener("message", (event) => {
          const decoded = decodeServerMessage(event.data);
          if (decoded === undefined) return;
          if (decoded.type === "ready") {
            terminalExited = decoded.state === "exited";
            if (decoded.replay) terminal.write(decoded.replay);
            setConnectionState(decoded.state);
            setDetail(
              decoded.state === "running"
                ? "已连接 · 刷新页面会附着同一会话"
                : "PowerShell 已退出",
            );
            if (decoded.writable) {
              socket?.send(
                JSON.stringify({
                  type: "resize",
                  cols: terminal.cols,
                  rows: terminal.rows,
                }),
              );
              terminal.focus();
            }
          } else if (decoded.type === "output") {
            terminal.write(decoded.data);
          } else if (decoded.type === "exit") {
            terminalExited = true;
            setConnectionState("exited");
            setDetail(`PowerShell 已退出（code ${decoded.exitCode}）`);
          } else {
            setDetail(decoded.message);
          }
        });
        socket.addEventListener("close", () => {
          if (!disposed && !terminalExited) {
            setConnectionState("unavailable");
            setDetail("无法附着该会话；Core 可能已重启");
          }
        });
        socket.addEventListener("error", () => {
          if (!disposed) {
            setConnectionState("unavailable");
            setDetail("WebSocket 连接失败");
          }
        });
      } catch (reason) {
        if (disposed) return;
        if (reason instanceof AuthenticationRequiredError) {
          onAuthenticationLost();
          return;
        }
        setConnectionState("unavailable");
        setDetail(reason instanceof Error ? reason.message : "无法创建终端");
      }
    }

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      dataSubscription.dispose();
      socket?.close();
      terminal.dispose();
    };
  }, [onAuthenticationLost]);

  return (
    <main className="workspace-shell">
      <header className="topbar">
        <div className="brand-inline">
          <span className="brand-mark small">SB</span>
          <div>
            <strong>StackBridge</strong>
            <span>Windows terminal prototype</span>
          </div>
        </div>
        <div className={`connection-pill ${connectionState}`}>
          <span className="status-dot" />
          {statusLabel(connectionState)}
        </div>
      </header>

      <section className="target-strip" aria-label="当前执行目标">
        <Info label="目标" value="本地 Windows" />
        <Info label="Shell" value="PowerShell · ConPTY" />
        <Info label="会话" value={sessionId?.slice(0, 8) ?? "创建中"} mono />
        <Info label="状态" value={detail} wide />
        {connectionState === "unavailable" || connectionState === "exited" ? (
          <button className="secondary-button" onClick={onCreateFreshTerminal}>
            新建终端
          </button>
        ) : null}
      </section>

      <section className="terminal-panel">
        <div className="terminal-toolbar">
          <span className="terminal-title">PowerShell</span>
          <span className="terminal-hint">Ctrl+C 可中断 · 页面刷新不会结束会话</span>
        </div>
        <div ref={terminalHost} className="terminal-host" />
      </section>
    </main>
  );
}

function Info({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={`target-info ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      <strong className={mono ? "mono" : ""}>{value}</strong>
    </div>
  );
}

function CenteredStatus({ message }: { message: string }) {
  return (
    <main className="centered-status">
      <div className="brand-mark">SB</div>
      <p>{message}</p>
    </main>
  );
}

async function createTerminalSession(cols: number, rows: number): Promise<string> {
  const response = await fetch("/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cols, rows }),
  });
  if (response.status === 401) throw new AuthenticationRequiredError();
  if (!response.ok) throw new Error("Core 无法创建 PowerShell 会话");
  const parsed = terminalSessionSnapshotSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Core 返回了无法识别的会话数据");
  return parsed.data.id;
}

function decodeServerMessage(data: unknown) {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = serverTerminalMessageSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function statusLabel(state: ConnectionState): string {
  if (state === "running") return "运行中";
  if (state === "exited") return "已退出";
  if (state === "unavailable") return "连接中断";
  return "连接中";
}

class AuthenticationRequiredError extends Error {}
