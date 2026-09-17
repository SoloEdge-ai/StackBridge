import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  deploymentProposalSchema,
  remoteExecutionResultSchema,
  remoteSessionSnapshotSchema,
  serverTerminalMessageSchema,
  terminalSessionSnapshotSchema,
  type DeploymentProposal,
  type RemoteExecutionResult,
  type RemoteSessionSnapshot,
} from "@stackbridge/protocol";

const storedSessionKey = "stackbridge.terminalSessionId";
const maximumTerminalQueueBytes = 4_194_304;
const terminalConnectionTimeoutMs = 5_000;

type AuthState = "checking" | "required" | "authenticated";
type ConnectionState = "connecting" | "running" | "exited" | "unavailable";

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [workspaceKey, setWorkspaceKey] = useState(0);
  const [workspace, setWorkspace] = useState<"local" | "remote">("local");

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

  return workspace === "local" ? (
    <TerminalWorkspace
      key={workspaceKey}
      onAuthenticationLost={() => setAuthState("required")}
      onCreateFreshTerminal={createFreshTerminal}
      onOpenRemote={() => setWorkspace("remote")}
    />
  ) : (
    <RemoteWorkspace
      onAuthenticationLost={() => setAuthState("required")}
      onOpenLocal={() => setWorkspace("local")}
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
            {submitting ? "正在验证…" : "进入工作台"}
          </button>
        </form>
      </section>
    </main>
  );
}

function TerminalWorkspace({
  onAuthenticationLost,
  onCreateFreshTerminal,
  onOpenRemote,
}: {
  onAuthenticationLost: () => void;
  onCreateFreshTerminal: () => void;
  onOpenRemote: () => void;
}) {
  const terminalHost = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [isWritable, setIsWritable] = useState(false);
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
    let canWrite = false;
    let socket: WebSocket | undefined;
    let connectionTimer: number | undefined;
    let outputQueueBytes = 0;
    let writingOutput = false;
    const outputQueue: string[] = [];
    const textEncoder = new TextEncoder();
    const enqueueOutput = (data: string) => {
      outputQueueBytes += textEncoder.encode(data).byteLength;
      if (outputQueueBytes > maximumTerminalQueueBytes) {
        outputQueue.length = 0;
        outputQueueBytes = 0;
        socket?.close(1013, "Terminal renderer fell behind");
        setConnectionState("unavailable");
        setDetail("终端输出过快，已断开以保护内存");
        return;
      }
      outputQueue.push(data);
      flushOutput();
    };
    const flushOutput = () => {
      if (writingOutput) return;
      const data = outputQueue.shift();
      if (data === undefined) return;
      writingOutput = true;
      outputQueueBytes -= textEncoder.encode(data).byteLength;
      terminal.write(data, () => {
        writingOutput = false;
        flushOutput();
      });
    };
    const dataSubscription = terminal.onData((data) => {
      if (canWrite && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (canWrite && socket?.readyState === WebSocket.OPEN) {
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
        socketRef.current = socket;
        connectionTimer = window.setTimeout(() => {
          if (disposed || terminalExited) return;
          socket?.close();
          setConnectionState("unavailable");
          setDetail("连接终端超时；Core 可能已重启");
        }, terminalConnectionTimeoutMs);
        socket.addEventListener("message", (event) => {
          const decoded = decodeServerMessage(event.data);
          if (decoded === undefined) return;
          if (decoded.type === "ready") {
            clearConnectionTimer();
            canWrite = decoded.writable;
            setIsWritable(decoded.writable);
            terminalExited = decoded.state === "exited";
            if (decoded.replay) enqueueOutput(decoded.replay);
            setConnectionState(decoded.state);
            setDetail(
              decoded.state === "running"
                ? decoded.writable
                  ? "已连接 · 当前页面持有写入租约"
                  : "已连接 · 只读，另一页面持有写入租约"
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
            enqueueOutput(decoded.data);
          } else if (decoded.type === "writable") {
            canWrite = decoded.writable;
            setIsWritable(decoded.writable);
            setDetail(
              decoded.writable
                ? "已接管写入租约"
                : "只读，另一页面已接管写入租约",
            );
            if (decoded.writable) terminal.focus();
          } else if (decoded.type === "exit") {
            clearConnectionTimer();
            canWrite = false;
            setIsWritable(false);
            terminalExited = true;
            setConnectionState("exited");
            setDetail(`PowerShell 已退出（code ${decoded.exitCode}）`);
          } else {
            setDetail(decoded.message);
          }
        });
        socket.addEventListener("close", () => {
          clearConnectionTimer();
          canWrite = false;
          setIsWritable(false);
          if (!disposed && !terminalExited) {
            setConnectionState("unavailable");
            setDetail("无法附着该会话；Core 可能已重启");
          }
        });
        socket.addEventListener("error", () => {
          clearConnectionTimer();
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

    function clearConnectionTimer() {
      if (connectionTimer === undefined) return;
      window.clearTimeout(connectionTimer);
      connectionTimer = undefined;
    }

    return () => {
      disposed = true;
      clearConnectionTimer();
      resizeObserver.disconnect();
      canWrite = false;
      if (socketRef.current === socket) socketRef.current = undefined;
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
            <span>本地 PowerShell</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="nav-button active">本地终端</button>
          <button className="nav-button" onClick={onOpenRemote}>SSH / Docker</button>
          <div className={`connection-pill ${connectionState}`}>
            <span className="status-dot" />
            {statusLabel(connectionState)}
          </div>
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
        ) : connectionState === "running" && !isWritable ? (
          <button
            className="secondary-button"
            onClick={() =>
              socketRef.current?.send(
                JSON.stringify({ type: "acquireWriteLease" }),
              )
            }
          >
            接管输入
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

function RemoteWorkspace({
  onAuthenticationLost,
  onOpenLocal,
}: {
  onAuthenticationLost: () => void;
  onOpenLocal: () => void;
}) {
  const [host, setHost] = useState("friden-dev-cube");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("friden");
  const [useDocker, setUseDocker] = useState(false);
  const [container, setContainer] = useState("stackbridge-m0b1-ubuntu22");
  const [containerUser, setContainerUser] = useState("0");
  const [containerCwd, setContainerCwd] = useState("/");
  const [session, setSession] = useState<RemoteSessionSnapshot>();
  const sessionIdRef = useRef<string | undefined>(undefined);
  const [approval, setApproval] = useState<{ id: string; proposal: DeploymentProposal }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [program, setProgram] = useState("/usr/bin/uname");
  const [argsText, setArgsText] = useState("-a");
  const [cwd, setCwd] = useState("/home/friden");
  const [timeout, setTimeoutValue] = useState("15000");
  const [result, setResult] = useState<RemoteExecutionResult>();

  useEffect(() => () => {
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      void fetch(`/v1/remote-sessions/${sessionId}`, { method: "DELETE", keepalive: true });
    }
  }, []);

  async function connect(deploymentApprovalId?: string) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/v1/remote-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          host,
          port: Number(port),
          user,
          ...(deploymentApprovalId === undefined ? {} : { deploymentApprovalId }),
          ...(useDocker ? {
            docker: {
              contextName: "default",
              selector: container,
              requestedUser: containerUser,
              cwd: containerCwd,
            },
          } : {}),
        }),
      });
      if (response.status === 401) throw new AuthenticationRequiredError();
      const body: unknown = await response.json();
      if (response.status === 409) {
        if (
          typeof body !== "object" || body === null ||
          !("error" in body) || body.error !== "deployment_approval_required"
        ) {
          throw new Error(readApiError(body, "部署确认已失效，请重新连接"));
        }
        const candidate = typeof body === "object" && body !== null && "proposal" in body
          ? (body as { proposal: unknown }).proposal
          : undefined;
        const approvalId = typeof body === "object" && body !== null && "approvalId" in body
          ? (body as { approvalId: unknown }).approvalId
          : undefined;
        const parsedProposal = deploymentProposalSchema.safeParse(candidate);
        if (!parsedProposal.success || typeof approvalId !== "string" || !isUuid(approvalId)) {
          throw new Error("Core 返回了无法识别的部署确认信息");
        }
        setApproval({ id: approvalId, proposal: parsedProposal.data });
        return;
      }
      if (!response.ok) throw new Error(readApiError(body, "远端连接失败"));
      const parsed = remoteSessionSnapshotSchema.safeParse(body);
      if (!parsed.success) throw new Error("Core 返回了无法识别的远端会话");
      setSession(parsed.data);
      sessionIdRef.current = parsed.data.sessionId;
      setApproval(undefined);
      setCwd(parsed.data.defaultCwd);
      setResult(undefined);
    } catch (reason) {
      if (reason instanceof AuthenticationRequiredError) onAuthenticationLost();
      else setError(reason instanceof Error ? reason.message : "远端连接失败");
    } finally {
      setBusy(false);
    }
  }

  async function execute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const response = await fetch(`/v1/remote-sessions/${session.sessionId}/manual-execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd,
          program,
          args: argsText.split(/\r?\n/).filter((value) => value.length > 0),
          timeoutMs: Number(timeout),
        }),
      });
      if (response.status === 401) throw new AuthenticationRequiredError();
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(readApiError(body, "命令执行失败"));
      const parsed = remoteExecutionResultSchema.safeParse(body);
      if (!parsed.success) throw new Error("Core 返回了无法识别的执行结果");
      setResult(parsed.data);
    } catch (reason) {
      if (reason instanceof AuthenticationRequiredError) onAuthenticationLost();
      else setError(reason instanceof Error ? reason.message : "命令执行失败");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (session) {
      await fetch(`/v1/remote-sessions/${session.sessionId}`, { method: "DELETE" }).catch(() => undefined);
    }
    setSession(undefined);
    sessionIdRef.current = undefined;
    setApproval(undefined);
    setResult(undefined);
  }

  return (
    <main className="remote-shell">
      <header className="topbar">
        <div className="brand-inline">
          <span className="brand-mark small">SB</span>
          <div>
            <strong>StackBridge</strong>
            <span>受管 SSH runtime</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="nav-button" onClick={onOpenLocal}>本地终端</button>
          <button className="nav-button active">SSH / Docker</button>
          <div className={`connection-pill ${session ? "running" : ""}`}>
            <span className="status-dot" />
            {session ? "已连接" : busy ? "处理中" : "未连接"}
          </div>
        </div>
      </header>

      <div className="remote-content">
        <section className="remote-card connection-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">TARGET</p>
              <h1>连接 Linux</h1>
            </div>
            {session ? <button className="ghost-button" onClick={() => void disconnect()}>断开</button> : null}
          </div>
          <p className="muted compact">使用本机 OpenSSH 配置与 known_hosts。StackBridge 只在版本缺失或变化时请求部署确认。</p>
          <form className="remote-form" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
            <div className="form-grid three">
              <Field label="SSH 主机">
                <input value={host} onChange={(event) => setHost(event.target.value)} disabled={!!session || !!approval || busy} />
              </Field>
              <Field label="端口">
                <input type="number" value={port} onChange={(event) => setPort(event.target.value)} disabled={!!session || !!approval || busy} />
              </Field>
              <Field label="用户">
                <input value={user} onChange={(event) => setUser(event.target.value)} disabled={!!session || !!approval || busy} />
              </Field>
            </div>
            <label className="checkbox-row">
              <input type="checkbox" checked={useDocker} onChange={(event) => setUseDocker(event.target.checked)} disabled={!!session || !!approval || busy} />
              连接宿主上的 Docker 容器
            </label>
            {useDocker ? (
              <div className="form-grid three">
                <Field label="容器名称 / ID">
                  <input value={container} onChange={(event) => setContainer(event.target.value)} disabled={!!session || !!approval || busy} />
                </Field>
                <Field label="容器用户">
                  <input value={containerUser} onChange={(event) => setContainerUser(event.target.value)} disabled={!!session || !!approval || busy} />
                </Field>
                <Field label="容器目录">
                  <input value={containerCwd} onChange={(event) => setContainerCwd(event.target.value)} disabled={!!session || !!approval || busy} />
                </Field>
              </div>
            ) : null}
            {!session ? <button type="submit" disabled={busy || !host || !user}>{busy ? "正在探测…" : "连接"}</button> : null}
          </form>

          {approval ? (
            <div className="approval-card">
              <p className="eyebrow">DEPLOYMENT APPROVAL</p>
              <h2>需要同步远端 runtime</h2>
              <dl>
                <div><dt>位置</dt><dd>{approval.proposal.installRoot}</dd></div>
                <div><dt>版本</dt><dd>{approval.proposal.runtimeVersion} · {approval.proposal.arch}</dd></div>
                <div><dt>用户</dt><dd>{approval.proposal.user}@{approval.proposal.host}</dd></div>
                <div><dt>主机指纹</dt><dd className="mono breakable">{approval.proposal.hostKeyFingerprint}</dd></div>
                <div><dt>权限</dt><dd>{approval.proposal.permissions}</dd></div>
                <div><dt>清理</dt><dd>断开 StackBridge 后删除 {approval.proposal.installRoot}</dd></div>
              </dl>
              <p className="approval-note">远端不需要安装 Go、Node 或 Python；不会使用 sudo，也不会从互联网执行脚本。</p>
              <div className="button-row">
                <button className="ghost-button" onClick={() => setApproval(undefined)} disabled={busy}>取消</button>
                <button onClick={() => void connect(approval.id)} disabled={busy}>{busy ? "正在同步…" : "确认并连接"}</button>
              </div>
            </div>
          ) : null}
          {error ? <p className="form-error error-panel">{error}</p> : null}
        </section>

        <section className="remote-card runtime-card">
          {session ? (
            <>
              <div className="runtime-summary">
                <Info label="目标" value={session.targetKind === "docker" ? `Docker · ${session.containerId?.slice(0, 12)}` : "SSH 宿主"} />
                <Info label="Runtime" value={`${session.runtimeVersion} · ${session.arch}`} mono />
                <Info label="部署" value={deploymentLabel(session.deployment)} />
                <Info label="目录" value={session.defaultCwd} mono />
                <Info label="主机指纹" value={session.hostKeyFingerprint} mono />
              </div>
              <form className="command-form" onSubmit={(event) => void execute(event)}>
                <div className="section-heading command-heading">
                  <div>
                    <p className="eyebrow">STRUCTURED EXEC</p>
                    <h2>手动执行 argv</h2>
                  </div>
                  <button type="submit" disabled={busy || !program || !cwd}>{busy ? "执行中…" : "运行"}</button>
                </div>
                <div className="form-grid two">
                  <Field label="程序（绝对路径）">
                    <input value={program} onChange={(event) => setProgram(event.target.value)} />
                  </Field>
                  <Field label="工作目录">
                    <input value={cwd} onChange={(event) => setCwd(event.target.value)} />
                  </Field>
                </div>
                <div className="form-grid two">
                  <Field label="参数（每行一个）">
                    <textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} rows={4} />
                  </Field>
                  <Field label="超时（毫秒）">
                    <input type="number" min="1" max="86400000" value={timeout} onChange={(event) => setTimeoutValue(event.target.value)} />
                  </Field>
                </div>
              </form>
              <div className="output-panel" aria-live="polite">
                <div className="output-toolbar">
                  <span>执行结果</span>
                  {result ? <span>exit {result.exitCode}{result.timedOut ? " · timeout" : ""}</span> : null}
                </div>
                <pre>{result ? `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}` : "连接后可执行基础的结构化命令。"}</pre>
              </div>
            </>
          ) : (
            <div className="empty-runtime">
              <div className="brand-mark">↗</div>
              <h2>远端工作区</h2>
              <p>连接后这里会显示已核验的主机指纹、runtime 版本、目标目录和命令结果。</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function readApiError(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof (body as { error: unknown }).error === "string") {
    return `${fallback}：${(body as { error: string }).error}`;
  }
  return fallback;
}

function deploymentLabel(value: RemoteSessionSnapshot["deployment"]): string {
  if (value === "installed") return "首次安装";
  if (value === "upgraded") return "已升级";
  return "已复用";
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
