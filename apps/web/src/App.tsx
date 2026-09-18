import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  conversationSnapshotSchema,
  serverTerminalMessageSchema,
  terminalSessionSnapshotSchema,
  type AiAccountStatus,
  type CommandProposal,
  type ConversationSnapshot,
  type OperationSnapshot,
} from "@stackbridge/protocol";

const tabsStorageKey = "stackbridge.terminalTabs.v2";
const shortcutStorageKey = "stackbridge.aiShortcut";

type AuthState = "checking" | "unavailable" | "authenticated";
type ConnectionState = "connecting" | "running" | "exited" | "unavailable";

interface TerminalTab {
  id: string;
  title: string;
  kind: "local" | "ssh" | "docker";
}

interface TerminalEnvironment {
  id: string;
  kind: "local" | "ssh" | "docker";
  label: string;
  verified: boolean;
  bindingId?: string;
  host?: string;
  containerId?: string;
}

interface TerminalContext {
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

interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authAttempt, setAuthAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setAuthState("checking");
    void (async () => {
      try {
        let response = await fetch("/v1/auth/status", { cache: "no-store" });
        if (response.status === 401) {
          response = await fetch("/v1/auth/session", { method: "POST" });
        }
        if (!response.ok) throw new Error("Core rejected the local browser session");
        if (!cancelled) setAuthState("authenticated");
      } catch {
        if (!cancelled) setAuthState("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authAttempt]);

  if (authState === "checking") return <CenteredStatus message="正在连接本地 Core…" />;
  if (authState === "unavailable") {
    return (
      <main className="centered-status">
        <p>无法连接本地 Core。</p>
        <button className="primary-button" onClick={() => setAuthAttempt((value) => value + 1)}>
          重新连接
        </button>
      </main>
    );
  }
  return <Workspace onAuthenticationLost={() => setAuthAttempt((value) => value + 1)} />;
}

function Workspace({ onAuthenticationLost }: { onAuthenticationLost: () => void }) {
  const [tabs, setTabs] = useState<TerminalTab[]>(readStoredTabs);
  const [activeId, setActiveId] = useState(() => readStoredTabs()[0]?.id ?? "");
  const [context, setContext] = useState<TerminalContext>();
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [writable, setWritable] = useState(false);
  const [detail, setDetail] = useState("正在创建终端");
  const [aiOpen, setAiOpen] = useState(true);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcut, setShortcut] = useState(
    () => localStorage.getItem(shortcutStorageKey) ?? "Ctrl+Shift+Space",
  );
  const creatingInitial = useRef(false);

  const persistTabs = useCallback((next: TerminalTab[]) => {
    setTabs(next);
    sessionStorage.setItem(tabsStorageKey, JSON.stringify(next));
  }, []);

  const addTerminal = useCallback(async (body: Record<string, unknown>, title: string, kind: TerminalTab["kind"]) => {
    const response = await fetch("/v1/terminal-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 401) {
      onAuthenticationLost();
      throw new Error("本地会话已失效");
    }
    if (response.status === 409 && payload.error === "deployment_approval_required") {
      throw new DeploymentRequired(payload);
    }
    if (!response.ok) throw new Error(apiError(payload, "无法创建终端"));
    const parsed = terminalSessionSnapshotSchema.parse(payload);
    const tab = { id: parsed.id, title, kind };
    const next = [...tabs, tab];
    persistTabs(next);
    setContext(undefined);
    setConnectionState("connecting");
    setWritable(false);
    setActiveId(tab.id);
    return tab;
  }, [onAuthenticationLost, persistTabs, tabs]);

  useEffect(() => {
    if (tabs.length > 0 || creatingInitial.current) return;
    creatingInitial.current = true;
    void addTerminal({ cols: 120, rows: 32, kind: "local" }, "PowerShell", "local")
      .catch((reason) => setDetail(errorMessage(reason)))
      .finally(() => {
        creatingInitial.current = false;
      });
  }, [addTerminal, tabs.length]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (matchesShortcut(event, shortcut)) {
        event.preventDefault();
        setAiOpen((open) => !open);
        return;
      }
      if (event.key === "Escape" && aiOpen) {
        setAiOpen(false);
        window.dispatchEvent(new Event("stackbridge:terminal-focus"));
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [aiOpen, shortcut]);

  const removeUnavailable = useCallback((id: string) => {
    const next = tabs.filter((tab) => tab.id !== id);
    persistTabs(next);
    if (activeId === id) setActiveId(next[0]?.id ?? "");
  }, [activeId, persistTabs, tabs]);

  const handleTerminalState = useCallback((state: ConnectionState, canWrite: boolean, message: string) => {
    setConnectionState(state);
    setWritable(canWrite);
    setDetail(message);
  }, []);

  const handleActiveTerminalUnavailable = useCallback(() => {
    if (activeId) removeUnavailable(activeId);
  }, [activeId, removeUnavailable]);

  const selectTerminal = useCallback((id: string) => {
    if (id === activeId) return;
    setContext(undefined);
    setConnectionState("connecting");
    setWritable(false);
    setDetail("正在附着终端");
    setActiveId(id);
  }, [activeId]);

  const closeTerminal = useCallback(async (id: string) => {
    const response = await fetch(`/v1/terminal-sessions/${id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      setDetail(apiError(payload, "无法关闭终端"));
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === id);
    const next = tabs.filter((tab) => tab.id !== id);
    persistTabs(next);
    if (activeId === id) {
      setContext(undefined);
      setConnectionState("connecting");
      setWritable(false);
      setActiveId(next[Math.min(Math.max(index, 0), next.length - 1)]?.id ?? "");
    }
  }, [activeId, persistTabs, tabs]);

  const activeTab = tabs.find((tab) => tab.id === activeId);
  const breadcrumb = context?.environmentStack.map((item) => item.label).join(" → ") ?? "正在识别环境";

  return (
    <main className={`workbench ${aiOpen ? "with-ai" : ""}`}>
      <nav className="activity-rail" aria-label="工作台导航">
        <div className="rail-brand" title="StackBridge">S</div>
        <button className="rail-button active" title="终端" aria-label="终端">
          <AppIcon name="terminal" />
        </button>
        <button className="rail-button" title="新建连接" aria-label="新建连接" onClick={() => setConnectionOpen(true)}>
          <AppIcon name="connection" />
        </button>
        <button className={`rail-button ${aiOpen ? "active" : ""}`} title="AI 助手" aria-label="AI 助手" onClick={() => setAiOpen((value) => !value)}>
          <AppIcon name="spark" />
        </button>
        <div className="rail-spacer" />
        <button className="rail-button" title="设置" aria-label="设置" onClick={() => setSettingsOpen(true)}>
          <AppIcon name="settings" />
        </button>
      </nav>

      <section className="terminal-workspace">
        <header className="topbar">
          <div className="tab-strip">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`terminal-tab-group ${tab.id === activeId ? "active" : ""}`}
              >
                <button className="terminal-tab" onClick={() => selectTerminal(tab.id)}>
                  <span className={`tab-dot ${tab.kind}`} />
                  <span>{tab.title}</span>
                  {tab.id === activeId ? <small>{tab.kind === "local" ? "LOCAL" : tab.kind.toUpperCase()}</small> : null}
                </button>
                <button
                  className="terminal-tab-close"
                  aria-label={`关闭 ${tab.title}`}
                  title="关闭终端"
                  onClick={() => void closeTerminal(tab.id)}
                >×</button>
              </div>
            ))}
            <button className="new-tab-button" title="新建本地终端" onClick={() => void addTerminal({ cols: 120, rows: 32, kind: "local" }, "PowerShell", "local")}>＋</button>
          </div>
        </header>

        <section className="environment-bar">
          <div className="environment-main">
            <span className={`status-dot ${connectionState}`} />
            <div className="environment-copy">
              <span>ACTIVE CONTEXT</span>
              <strong>{breadcrumb}</strong>
            </div>
            {context === undefined
              ? <span className="detecting-pill">识别中</span>
              : context.environment.verified
                ? <span className="verified-pill">已核验</span>
                : <span className="warning-pill">环境未核验</span>}
          </div>
          <div className="environment-meta">
            <span><small>PATH</small><code>{context?.cwd || "—"}</code></span>
            <span><small>SHELL</small><code>{context?.shell || "—"}</code></span>
            <span className="shell-state">{context?.shellState === "idle" ? "READY" : context?.shellState === "running" ? "RUNNING" : "DETECTING"}</span>
          </div>
        </section>

        <section className="terminal-area">
          {activeTab ? (
            <TerminalPane
              key={activeTab.id}
              sessionId={activeTab.id}
              onContext={setContext}
              onState={handleTerminalState}
              onUnavailable={handleActiveTerminalUnavailable}
            />
          ) : <CenteredStatus message="正在准备终端…" />}
          <footer className="terminal-status">
            <span className={writable ? "writable" : ""}>{writable ? "● INPUT" : "○ READ ONLY"}</span>
            <span>{detail}</span>
            <span>SESSION {activeTab ? activeTab.id.slice(0, 8).toUpperCase() : "—"}</span>
          </footer>
        </section>
      </section>

      {aiOpen && activeTab ? (
        <AssistantPanel
          terminalId={activeTab.id}
          context={context}
          shortcut={shortcut}
          onClose={() => {
            setAiOpen(false);
            window.dispatchEvent(new Event("stackbridge:terminal-focus"));
          }}
        />
      ) : null}

      {connectionOpen ? (
        <ConnectionDialog
          onClose={() => setConnectionOpen(false)}
          onCreate={async (request, title, kind) => {
            await addTerminal(request, title, kind);
            setConnectionOpen(false);
          }}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsDialog
          shortcut={shortcut}
          onSave={(value) => {
            localStorage.setItem(shortcutStorageKey, value);
            setShortcut(value);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </main>
  );
}

function AppIcon({ name }: { name: "terminal" | "connection" | "spark" | "settings" }) {
  if (name === "terminal") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 7 4 4-4 4M11 16h7" /></svg>;
  }
  if (name === "connection") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8H7a5 5 0 0 0 0 10h3m5-4h2a5 5 0 0 0 0-10h-3m-6 8h8" /></svg>;
  }
  if (name === "spark") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Zm6 11 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14Z" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19 13.5v-3l-2-.7-.8-1.8.9-2-2.1-2.1-2 .9-1.8-.8-.7-2h-3l-.7 2-1.8.8-2-.9L.9 6l.9 2L1 9.8l-2 .7v3l2 .7.8 1.8-.9 2L3 20.1l2-.9 1.8.8.7 2h3l.7-2 1.8-.8 2 .9 2.1-2.1-.9-2 .8-1.8 2-.7Z" transform="translate(2) scale(.83)" /></svg>;
}

function TerminalPane({
  sessionId,
  onContext,
  onState,
  onUnavailable,
}: {
  sessionId: string;
  onContext(context: TerminalContext): void;
  onState(state: ConnectionState, writable: boolean, detail: string): void;
  onUnavailable(): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 20_000,
      allowProposedApi: false,
      theme: {
        background: "#0a0a0d",
        foreground: "#d9d9e0",
        cursor: "#aeb8ff",
        cursorAccent: "#0a0a0d",
        selectionBackground: "#59639a66",
        black: "#16161b",
        red: "#ff7d90",
        green: "#5de4c7",
        yellow: "#efc56d",
        blue: "#91a1ff",
        magenta: "#c6a0f6",
        cyan: "#7ad7e5",
        white: "#d9d9e0",
        brightBlack: "#686875",
        brightRed: "#ff9aac",
        brightGreen: "#82ead4",
        brightYellow: "#f4d48f",
        brightBlue: "#b3bdff",
        brightMagenta: "#d7b9ff",
        brightCyan: "#a4e7ef",
        brightWhite: "#f2f2f5",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminal.focus();
    let disposed = false;
    let socket: WebSocket | undefined;
    let canWrite = false;
    let replaying = false;
    let poll: number | undefined;

    const dataSubscription = terminal.onData((data) => {
      if (canWrite && !replaying && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (canWrite && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    });
    resizeObserver.observe(host);
    const focus = () => terminal.focus();
    window.addEventListener("stackbridge:terminal-focus", focus);

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/v1/terminal-sessions/${sessionId}/stream`);
    socket.addEventListener("message", (event) => {
      const decoded = decodeServerMessage(event.data);
      if (decoded === undefined) return;
      if (decoded.type === "ready") {
        const finishReplay = () => {
          replaying = false;
          canWrite = decoded.writable;
          onState(decoded.state, decoded.writable, decoded.state === "running" ? "已连接真实 PTY" : "Shell 已退出");
          if (decoded.writable) {
            socket?.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
            terminal.focus();
          }
        };
        if (decoded.replay) {
          replaying = true;
          canWrite = false;
          terminal.write(decoded.replay, finishReplay);
        } else finishReplay();
      } else if (decoded.type === "output") terminal.write(decoded.data);
      else if (decoded.type === "writable") {
        canWrite = decoded.writable;
        onState("running", canWrite, canWrite ? "当前页面持有写入租约" : "另一页面持有写入租约");
      } else if (decoded.type === "exit") {
        canWrite = false;
        onState("exited", false, `Shell 已退出 (${decoded.exitCode})`);
      } else terminal.writeln(`\r\n[StackBridge] ${decoded.message}`);
    });
    socket.addEventListener("close", (event) => {
      if (disposed) return;
      canWrite = false;
      if (event.code === 1006) onState("unavailable", false, "与 Core 的连接中断");
    });
    socket.addEventListener("error", () => onState("unavailable", false, "终端连接失败"));

    const updateContext = async () => {
      try {
        const response = await fetch(`/v1/terminal-sessions/${sessionId}/context`, { cache: "no-store" });
        if (response.status === 404) {
          onUnavailable();
          return;
        }
        if (response.ok) onContext(await response.json() as TerminalContext);
      } catch {}
    };
    void updateContext();
    poll = window.setInterval(() => void updateContext(), 700);

    return () => {
      disposed = true;
      if (poll !== undefined) clearInterval(poll);
      window.removeEventListener("stackbridge:terminal-focus", focus);
      resizeObserver.disconnect();
      dataSubscription.dispose();
      socket?.close();
      terminal.dispose();
    };
  }, [onContext, onState, onUnavailable, sessionId]);
  return <div className="terminal-host" ref={hostRef} />;
}

function AssistantPanel({
  terminalId,
  context,
  shortcut,
  onClose,
}: {
  terminalId: string;
  context: TerminalContext | undefined;
  shortcut: string;
  onClose(): void;
}) {
  const [account, setAccount] = useState<AiAccountStatus>();
  const [models, setModels] = useState<CodexModel[]>([]);
  const [model, setModel] = useState("gpt-5.6-sol");
  const [conversation, setConversation] = useState<ConversationSnapshot>();
  const [conversations, setConversations] = useState<ConversationSnapshot[]>([]);
  const [message, setMessage] = useState("");
  const [pendingMessage, setPendingMessage] = useState<string>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [loginId, setLoginId] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshAccount = useCallback(async () => {
    const response = await fetch("/v1/ai/account/status", { cache: "no-store" });
    setAccount(await response.json() as AiAccountStatus);
  }, []);
  const refreshConversations = useCallback(async () => {
    const response = await fetch("/v1/conversations", { cache: "no-store" });
    if (response.ok) setConversations(((await response.json()) as { data: ConversationSnapshot[] }).data);
  }, []);

  useEffect(() => {
    void refreshAccount();
    void refreshConversations();
    void fetch("/v1/ai/models", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const data = ((await response.json()) as { data: CodexModel[] }).data;
      setModels(data);
      const preferred = data.find((item) => item.isDefault) ?? data[0];
      if (preferred) setModel(preferred.model);
    });
  }, [refreshAccount, refreshConversations]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [conversation, pendingMessage]);

  async function login() {
    setError(undefined);
    try {
      const result = await api<{ loginId: string; authUrl: string }>("/v1/ai/account/login", { method: "POST" });
      setLoginId(result.loginId);
      window.open(result.authUrl, "_blank", "noopener,noreferrer");
      const interval = window.setInterval(() => void refreshAccount(), 1_500);
      window.setTimeout(() => clearInterval(interval), 120_000);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function cancelLogin() {
    if (!loginId) return;
    setError(undefined);
    try {
      await api("/v1/ai/account/login/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginId }),
      });
      setLoginId(undefined);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function createConversation(): Promise<ConversationSnapshot> {
    const created = await api<ConversationSnapshot>("/v1/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 2, terminalSessionId: terminalId, model }),
    });
    const parsed = conversationSnapshotSchema.parse(created);
    setConversation(parsed);
    await refreshConversations();
    return parsed;
  }

  async function send(text = message, commandIds?: string[]) {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(undefined);
    setPendingMessage(text.trim());
    setMessage("");
    try {
      const current = conversation ?? await createConversation();
      const updated = await api<ConversationSnapshot>(`/v1/conversations/${current.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 2, terminalSessionId: terminalId, message: text.trim(), ...(commandIds ? { commandIds } : {}) }),
      });
      setConversation(conversationSnapshotSchema.parse(updated));
      await refreshConversations();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSending(false);
      setPendingMessage(undefined);
    }
  }

  async function decide(proposal: CommandProposal, decision: "execute" | "insert" | "reject") {
    setError(undefined);
    try {
      const result = await api<{ proposal: CommandProposal }>(`/v1/approvals/${proposal.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 2, decision }),
      });
      setConversation((current) => current && ({
        ...current,
        proposals: current.proposals.map((item) => item.id === proposal.id ? result.proposal : item),
      }));
      if (decision === "insert") window.dispatchEvent(new Event("stackbridge:terminal-focus"));
    } catch (reason) {
      setError(errorMessage(reason));
      if (conversation) {
        const refreshed = await api<ConversationSnapshot>(`/v1/conversations/${conversation.id}`);
        setConversation(refreshed);
      }
    }
  }

  if (!account) return <aside className="assistant-panel loading-panel"><PanelHeader title="AI 助手" subtitle={shortcut} onClose={onClose} /><CenteredStatus message="正在连接 Codex…" /></aside>;
  if (!account.authenticated) {
    return (
      <aside className="assistant-panel">
        <PanelHeader title="Terminal AI" subtitle={shortcut} onClose={onClose} />
        <div className="account-empty">
          <div className="ai-hero">
            <div className="ai-orb"><AppIcon name="spark" /></div>
            <span className="ai-kicker">CODEX · CONTEXT AWARE</span>
            <h2>让终端自己解释终端</h2>
            <p>直接询问刚才的命令和输出。StackBridge 会自动带上当前主机、容器、目录和 Shell。</p>
          </div>
          <div className="ai-capabilities">
            <div><span>01</span><p><strong>理解现场</strong><small>自动关联最近命令与输出</small></p></div>
            <div><span>02</span><p><strong>给出命令</strong><small>建议始终固定到当前环境</small></p></div>
            <div><span>03</span><p><strong>确认再执行</strong><small>每条命令都由你最终决定</small></p></div>
          </div>
          {loginId ? <>
            <p className="form-note">授权页面已打开。完成后回到这里检查状态；若网络或地区不可用，可以取消后重试。</p>
            <button className="primary-button" onClick={() => void refreshAccount()}>检查登录状态</button>
            <button className="ghost-button" onClick={() => void cancelLogin()}>取消本次登录</button>
          </> : <button className="primary-button ai-login-button" onClick={() => void login()}>使用 ChatGPT 登录 <span>↗</span></button>}
          <p className="privacy-note">登录凭据由独立 Codex 数据目录与系统凭据库保存。</p>
          {account.error ? <p className="form-error">{account.error}</p> : null}
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      </aside>
    );
  }

  return (
    <aside className="assistant-panel">
      <PanelHeader title="AI 助手" subtitle={account.accountLabel ?? shortcut} onClose={onClose} />
      <div className="assistant-tools">
        <select value={model} onChange={(event) => setModel(event.target.value)} disabled={!!conversation}>
          {(models.length ? models : [{ model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" } as CodexModel]).map((item) => (
            <option key={item.model} value={item.model}>{item.displayName}</option>
          ))}
        </select>
        <button className="ghost-button compact" onClick={() => setConversation(undefined)}>＋ 新对话</button>
        {conversations.length ? (
          <select className="history-select" value={conversation?.id ?? ""} onChange={(event) => {
            const selected = conversations.find((item) => item.id === event.target.value);
            setConversation(selected);
          }}>
            <option value="">历史对话</option>
            {conversations.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        ) : null}
      </div>
      <div className="context-chip-row">
        <span className={`context-chip ${context?.environment.verified === false ? "warning" : ""}`}>{context?.environment.label ?? "识别环境中"}</span>
        <span className="context-chip">附带最近 {Math.min(3, context?.recentCommandIds.length ?? 0)} 条输出</span>
        <details className="context-preview"><summary>检查上下文</summary><pre>{JSON.stringify({
          environment: context?.environment,
          cwd: context?.cwd,
          shell: context?.shell,
          commandIds: context?.recentCommandIds.slice(-3),
        }, null, 2)}</pre></details>
      </div>
      <div className="message-list" ref={scrollRef}>
        {!conversation?.messages.length ? (
          <div className="conversation-empty">
            <div className="ai-orb small">✦</div>
            <h3>不用复制终端输出</h3>
            <p>直接问“刚才的错误是什么意思？”或“这个命令怎么写？”。</p>
            <div className="prompt-suggestions">
              {["解释刚才的输出", "给我一个安全的排查命令", "当前在哪个环境？"].map((item) => (
                <button key={item} onClick={() => void send(item)}>{item}</button>
              ))}
            </div>
          </div>
        ) : conversation.messages.map((item) => (
          <div key={item.id} className={`message ${item.role}`}>
            <div className="message-role">{item.role === "user" ? "你" : item.role === "assistant" ? "AI" : "环境"}</div>
            <div className="message-body">{item.content}</div>
            {item.proposalIds?.map((id) => {
              const proposal = conversation.proposals.find((candidate) => candidate.id === id);
              return proposal ? <ProposalCard key={id} proposal={proposal} onDecision={decide} onExplain={(commandId) => void send("解释这条命令执行后的输出，并告诉我是否正常。", [commandId])} /> : null;
            })}
          </div>
        ))}
        {pendingMessage ? <div className="message user pending"><div className="message-role">你</div><div className="message-body">{pendingMessage}</div></div> : null}
        {sending ? <div className="thinking"><span /><span /><span /> Codex 正在分析当前终端…</div> : null}
      </div>
      {error ? <div className="panel-error">{error}</div> : null}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="问当前命令、输出或下一步…"
          disabled={sending}
          rows={3}
        />
        <div className="composer-footer">
          <span>Enter 发送 · Shift+Enter 换行</span>
          {sending ? (
            <button type="button" className="danger-button" onClick={() => {
              if (conversation) void fetch(`/v1/conversations/${conversation.id}/stop`, { method: "POST" });
            }}>停止</button>
          ) : <button className="send-button" disabled={!message.trim()}>发送 ↑</button>}
        </div>
      </form>
    </aside>
  );
}

function ProposalCard({ proposal, onDecision, onExplain }: {
  proposal: CommandProposal;
  onDecision(proposal: CommandProposal, decision: "execute" | "insert" | "reject"): void;
  onExplain(commandBlockId: string): void;
}) {
  return (
    <section className="proposal-card">
      <div className="proposal-heading"><span>命令建议</span><StatusBadge status={proposal.status} /></div>
      <p>{proposal.purpose}</p>
      <pre><code>{proposal.command}</code></pre>
      <div className="proposal-target">
        <span>{proposal.environmentLabel}</span>
        <span>{proposal.host ?? (proposal.environmentKind === "local" ? "本机" : proposal.environmentKind)}</span>
        {proposal.containerId ? <span title={proposal.containerId}>容器 {proposal.containerId.slice(0, 12)}</span> : null}
        <span>{proposal.user || "当前用户"}</span><span>{proposal.cwd || "当前目录"}</span><span>{proposal.shell}</span>
      </div>
      {proposal.status === "pending" ? (
        <div className="proposal-actions">
          <button className="primary-button compact" onClick={() => onDecision(proposal, "execute")}>在此终端执行</button>
          <button className="ghost-button compact" onClick={() => onDecision(proposal, "insert")}>放入输入行</button>
          <button className="text-button" onClick={() => onDecision(proposal, "reject")}>暂不执行</button>
        </div>
      ) : proposal.operationId ? <OperationTracker id={proposal.operationId} onExplain={onExplain} /> : null}
    </section>
  );
}

function OperationTracker({ id, onExplain }: { id: string; onExplain(commandBlockId: string): void }) {
  const [operation, setOperation] = useState<OperationSnapshot>();
  useEffect(() => {
    let stopped = false;
    const update = async () => {
      const response = await fetch(`/v1/operations/${id}`, { cache: "no-store" });
      if (response.ok && !stopped) setOperation(await response.json() as OperationSnapshot);
    };
    void update();
    const timer = window.setInterval(() => void update(), 800);
    return () => { stopped = true; clearInterval(timer); };
  }, [id]);
  if (!operation) return <div className="operation-row">正在提交…</div>;
  return (
    <div className="operation-row">
      <StatusBadge status={operation.status} />
      {operation.exitCode !== undefined ? <span>退出码 {operation.exitCode}</span> : null}
      {operation.commandBlockId ? <button className="text-button" onClick={() => onExplain(operation.commandBlockId!)}>解释结果</button> : null}
    </div>
  );
}

function ConnectionDialog({ onClose, onCreate }: {
  onClose(): void;
  onCreate(request: Record<string, unknown>, title: string, kind: "ssh" | "docker"): Promise<void>;
}) {
  const [kind, setKind] = useState<"ssh" | "docker">("ssh");
  const [host, setHost] = useState("friden-dev-cube");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("friden");
  const [container, setContainer] = useState("stackbridge-m0b1-ubuntu22");
  const [containerUser, setContainerUser] = useState("root");
  const [cwd, setCwd] = useState("/workspace");
  const [contextName, setContextName] = useState("default");
  const [approval, setApproval] = useState<{ id: string; proposal: Record<string, unknown> }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const request = useMemo(() => kind === "ssh" ? {
    kind, cols: 120, rows: 32, host, port: Number(port), user,
  } : {
    kind, cols: 120, rows: 32, host, port: Number(port), user,
    contextName, container, containerUser, cwd,
  }, [container, containerUser, contextName, cwd, host, kind, port, user]);

  async function submit(event?: FormEvent, deploymentApprovalId?: string) {
    event?.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onCreate(
        { ...request, ...(deploymentApprovalId ? { deploymentApprovalId } : {}) },
        kind === "ssh" ? `${user}@${host}` : `Docker · ${container}`,
        kind,
      );
    } catch (reason) {
      if (reason instanceof DeploymentRequired) {
        setApproval({ id: String(reason.payload.approvalId), proposal: reason.payload.proposal as Record<string, unknown> });
      } else setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="新建连接" onClose={onClose}>
      <div className="segmented">
        <button className={kind === "ssh" ? "active" : ""} onClick={() => setKind("ssh")}>SSH 宿主</button>
        <button className={kind === "docker" ? "active" : ""} onClick={() => setKind("docker")}>远端 Docker</button>
      </div>
      <form className="connection-form" onSubmit={(event) => void submit(event)}>
        <div className="field-grid three">
          <Field label="主机"><input value={host} onChange={(event) => setHost(event.target.value)} required /></Field>
          <Field label="端口"><input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" required /></Field>
          <Field label="用户"><input value={user} onChange={(event) => setUser(event.target.value)} required /></Field>
        </div>
        {kind === "docker" ? <>
          <Field label="容器名称或 ID"><input value={container} onChange={(event) => setContainer(event.target.value)} required /></Field>
          <div className="field-grid three">
            <Field label="Docker Context"><input value={contextName} onChange={(event) => setContextName(event.target.value)} required /></Field>
            <Field label="容器用户"><input value={containerUser} onChange={(event) => setContainerUser(event.target.value)} required /></Field>
            <Field label="工作目录"><input value={cwd} onChange={(event) => setCwd(event.target.value)} required /></Field>
          </div>
        </> : null}
        <p className="form-note">使用系统 OpenSSH 配置和密钥。Core 会先核验主机与运行实例，再打开真实交互 PTY。</p>
        {approval ? (
          <div className="approval-box">
            <strong>需要部署远端 Runtime</strong>
            <p>将固定版本运行时安装到登录用户的 <code>~/.sbridge</code>。不会修改系统目录或 Shell 配置。</p>
            <dl>{Object.entries(approval.proposal).slice(0, 8).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void submit(undefined, approval.id)}>确认部署并连接</button>
          </div>
        ) : <button className="primary-button" disabled={busy}>{busy ? "正在核验…" : "连接"}</button>}
        {error ? <p className="form-error">{error}</p> : null}
      </form>
    </Modal>
  );
}

function SettingsDialog({ shortcut, onSave, onClose }: { shortcut: string; onSave(value: string): void; onClose(): void }) {
  const [value, setValue] = useState(shortcut);
  return (
    <Modal title="工作台设置" onClose={onClose}>
      <Field label="AI 面板快捷键"><input value={value} onChange={(event) => setValue(event.target.value)} /></Field>
      <p className="form-note">支持 Ctrl、Shift、Alt 与单个按键，例如 Ctrl+Shift+Space。中文输入法组合期间不会拦截。</p>
      <button className="primary-button" onClick={() => onSave(value)}>保存</button>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card"><header><h2>{title}</h2><button className="icon-button" onClick={onClose}>×</button></header>{children}</section></div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function PanelHeader({ title, subtitle, onClose }: { title: string; subtitle: string; onClose(): void }) {
  return <header className="panel-header"><div><h2>{title}</h2><span>{subtitle}</span></div><button className="icon-button" onClick={onClose}>×</button></header>;
}

function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    pending: "等待确认", accepted: "已提交", running: "执行中", completed: "完成",
    failed: "失败", interrupted: "已中断", unknown: "状态未知", inserted: "已放入输入行",
    rejected: "未执行", expired: "已过期", stale: "需要重新确认",
  };
  return <span className={`status-badge ${status}`}>{labels[status] ?? status}</span>;
}

function CenteredStatus({ message }: { message: string }) {
  return <div className="centered-status"><span className="spinner" /><p>{message}</p></div>;
}

class DeploymentRequired extends Error {
  constructor(readonly payload: Record<string, unknown>) {
    super("Remote runtime deployment requires approval");
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(apiError(payload, `请求失败 (${response.status})`));
  return payload as T;
}

function apiError(payload: Record<string, unknown>, fallback: string): string {
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error !== "string") return fallback;
  const messages: Record<string, string> = {
    terminal_session_limit_reached: "终端数量已达上限，请先关闭不用的标签。",
    remote_session_limit_reached: "远端连接数量已达上限，请先关闭不用的标签。",
    remote_terminals_unavailable: "远端终端服务当前不可用。",
    terminal_session_not_found: "这个终端已经关闭。",
  };
  return messages[payload.error] ?? payload.error;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "发生未知错误";
}

function readStoredTabs(): TerminalTab[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(tabsStorageKey) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is TerminalTab => !!item && typeof item === "object" && typeof (item as TerminalTab).id === "string");
  } catch {
    return [];
  }
}

function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split("+").map((item) => item.trim());
  const key = parts.at(-1);
  const eventKey = event.code === "Space" ? "space" : event.key.toLowerCase();
  return eventKey === key && event.ctrlKey === parts.includes("ctrl") && event.shiftKey === parts.includes("shift") && event.altKey === parts.includes("alt");
}

function decodeServerMessage(raw: unknown) {
  try {
    const text = typeof raw === "string" ? raw : raw instanceof Blob ? undefined : String(raw);
    return text === undefined ? undefined : serverTerminalMessageSchema.parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}
