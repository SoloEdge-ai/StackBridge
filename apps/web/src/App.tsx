import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  terminalSessionSnapshotSchema,
  type CreateTerminalSessionRequest,
} from "@stackbridge/protocol";
import { localizedKnownText, useLanguage } from "./i18n.js";
import {
  findPane,
  flattenPanes,
  isTerminalKind,
  paneLayout,
  removePane,
  reusableTerminalRequest,
  splitPane,
  type SplitDirection,
  type TerminalKind,
  type TerminalPaneItem,
  type TerminalTab,
} from "./workspace/terminal-layout.js";
import {
  readTerminalTabs,
  writeTerminalTabs,
} from "./workspace/terminal-tabs-store.js";
import { useQuickAskShortcut } from "./desktop/quick-ask-shortcut.js";
import {
  useAssistantController,
} from "./assistant/use-assistant-controller.js";
import { AssistantPanel } from "./assistant/AssistantPanel.js";
import { ConnectionDialog, SettingsDialog } from "./workspace/WorkspaceDialogs.js";
import {
  TerminalContextMenu,
  type TerminalContextMenuState,
} from "./workspace/TerminalContextMenu.js";
import { TerminalLayoutView } from "./workspace/TerminalLayoutView.js";
import { api, apiError, DeploymentRequired, errorMessage } from "./api/client.js";
import {
  connectingRuntime,
  type ConnectionState,
  type PaneRuntimeState,
  type TerminalContext,
  type TerminalCursorAnchor,
} from "./terminal/types.js";

const shortcutStorageKey = "stackbridge.aiShortcut";

type AuthState = "checking" | "unavailable" | "authenticated";

export function App() {
  const { t } = useLanguage();
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
        if (!cancelled) {
          setAuthState("authenticated");
          window.dispatchEvent(new Event("stackbridge:authenticated"));
        }
      } catch {
        if (!cancelled) setAuthState("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authAttempt]);

  if (authState === "checking") return <CenteredStatus message={t("正在连接本地 Core…")} />;
  if (authState === "unavailable") {
    return (
      <main className="centered-status">
        <p>{t("无法连接本地 Core。")}</p>
        <button className="primary-button" onClick={() => setAuthAttempt((value) => value + 1)}>
          {t("重新连接")}
        </button>
      </main>
    );
  }
  return <Workspace onAuthenticationLost={() => setAuthAttempt((value) => value + 1)} />;
}

function Workspace({ onAuthenticationLost }: { onAuthenticationLost: () => void }) {
  const { locale, setLocale, t } = useLanguage();
  const [tabs, setTabs] = useState<TerminalTab[]>(() => readTerminalTabs(sessionStorage));
  const [activeId, setActiveId] = useState(() => readTerminalTabs(sessionStorage)[0]?.id ?? "");
  const [paneRuntime, setPaneRuntime] = useState<Record<string, PaneRuntimeState>>({});
  const [splitMenu, setSplitMenu] = useState<TerminalContextMenuState>();
  const [workspaceError, setWorkspaceError] = useState<string>();
  const [aiOpen, setAiOpen] = useState(false);
  const [quickAiPaneId, setQuickAiPaneId] = useState<string>();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcut, setShortcut] = useState(
    () => {
      const saved = localStorage.getItem(shortcutStorageKey);
      return saved === null
        || saved === "Ctrl+Shift+Space"
        || saved === "Ctrl+Shift+A"
        || saved === "Ctrl+Alt+A"
        ? "F8"
        : saved;
    },
  );
  const creatingInitial = useRef(false);
  const paneElements = useRef(new Map<string, HTMLElement>());
  const cursorAnchors = useRef(new Map<string, TerminalCursorAnchor>());

  const persistTabs = useCallback((next: TerminalTab[]) => {
    setTabs(next);
    writeTerminalTabs(sessionStorage, next);
  }, []);

  const createTerminalSession = useCallback(async (
    body: CreateTerminalSessionRequest,
    title: string,
    kind: TerminalKind,
  ): Promise<TerminalPaneItem> => {
    const response = await fetch("/v1/terminal-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 401) {
      onAuthenticationLost();
      throw new Error(t("本地会话已失效"));
    }
    if (response.status === 409 && payload.error === "deployment_approval_required") {
      throw new DeploymentRequired(payload);
    }
    if (!response.ok) throw new Error(apiError(payload, t("无法创建终端"), t));
    const parsed = terminalSessionSnapshotSchema.parse(payload);
    return {
      id: parsed.id,
      title,
      kind,
      createRequest: reusableTerminalRequest(body),
    };
  }, [onAuthenticationLost, t]);

  const addTerminal = useCallback(async (body: CreateTerminalSessionRequest, title: string, kind: TerminalKind) => {
    const pane = await createTerminalSession(body, title, kind);
    const tab: TerminalTab = {
      id: pane.id,
      title,
      kind,
      layout: paneLayout(pane),
      activePaneId: pane.id,
    };
    const next = [...tabs, tab];
    persistTabs(next);
    setWorkspaceError(undefined);
    setActiveId(tab.id);
    return tab;
  }, [createTerminalSession, persistTabs, tabs]);

  useEffect(() => {
    if (tabs.length > 0 || creatingInitial.current) return;
    creatingInitial.current = true;
    void addTerminal({ cols: 120, rows: 32, kind: "local" }, "PowerShell", "local")
      .catch((reason) => setWorkspaceError(errorMessage(reason, t)))
      .finally(() => {
        creatingInitial.current = false;
      });
  }, [addTerminal, t, tabs.length]);

  const toggleQuickAsk = useCallback(() => {
    const tab = tabs.find((item) => item.id === activeId);
    const pane = tab
      ? findPane(tab.layout, tab.activePaneId) ?? flattenPanes(tab.layout)[0]
      : undefined;
    if (pane && quickAiPaneId === pane.id) {
      setQuickAiPaneId(undefined);
      window.dispatchEvent(new Event("stackbridge:terminal-focus"));
    } else if (pane) {
      setQuickAiPaneId(pane.id);
    }
  }, [activeId, quickAiPaneId, tabs]);

  useQuickAskShortcut(shortcut, toggleQuickAsk);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && quickAiPaneId) {
        setQuickAiPaneId(undefined);
        window.dispatchEvent(new Event("stackbridge:terminal-focus"));
        return;
      }
      if (event.key === "Escape" && splitMenu) {
        setSplitMenu(undefined);
        return;
      }
      if (event.key === "Escape" && aiOpen) {
        setAiOpen(false);
        window.dispatchEvent(new Event("stackbridge:terminal-focus"));
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [aiOpen, quickAiPaneId, splitMenu]);

  useEffect(() => {
    if (!splitMenu) return;
    const close = () => setSplitMenu(undefined);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [splitMenu]);

  const handleTerminalContext = useCallback((sessionId: string, context: TerminalContext) => {
    setPaneRuntime((current) => ({
      ...current,
      [sessionId]: {
        ...(current[sessionId] ?? connectingRuntime(t("正在附着终端"))),
        context,
      },
    }));
  }, [t]);

  const handleTerminalState = useCallback((
    sessionId: string,
    state: ConnectionState,
    canWrite: boolean,
    message: string,
  ) => {
    setPaneRuntime((current) => ({
      ...current,
      [sessionId]: {
        ...(current[sessionId] ?? connectingRuntime(t("正在附着终端"))),
        connectionState: state,
        writable: canWrite,
        detail: message,
      },
    }));
  }, [t]);

  const handlePaneElement = useCallback((sessionId: string, element: HTMLElement | null) => {
    if (element) paneElements.current.set(sessionId, element);
    else paneElements.current.delete(sessionId);
  }, []);

  const handleCursorAnchor = useCallback((
    sessionId: string,
    anchor: TerminalCursorAnchor | undefined,
  ) => {
    if (anchor) cursorAnchors.current.set(sessionId, anchor);
    else cursorAnchors.current.delete(sessionId);
  }, []);

  const selectTerminal = useCallback((id: string) => {
    if (id === activeId) return;
    setWorkspaceError(undefined);
    setSplitMenu(undefined);
    setQuickAiPaneId(undefined);
    setActiveId(id);
  }, [activeId]);

  const activatePane = useCallback((tabId: string, paneId: string) => {
    const next = tabs.map((tab) => tab.id === tabId && tab.activePaneId !== paneId
      ? { ...tab, activePaneId: paneId }
      : tab);
    if (next.some((tab, index) => tab !== tabs[index])) persistTabs(next);
    if (activeId !== tabId) setActiveId(tabId);
    setQuickAiPaneId((current) => current && current !== paneId ? undefined : current);
    setWorkspaceError(undefined);
  }, [activeId, persistTabs, tabs]);

  const closePane = useCallback(async (tabId: string, paneId: string) => {
    const response = await fetch(`/v1/terminal-sessions/${paneId}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      setWorkspaceError(apiError(payload, t("无法关闭终端"), t));
      return;
    }
    const tabIndex = tabs.findIndex((tab) => tab.id === tabId);
    const tab = tabs[tabIndex];
    if (!tab) return;
    const layout = removePane(tab.layout, paneId);
    const next = layout
      ? tabs.map((item) => item.id === tabId
        ? {
            ...item,
            layout,
            activePaneId: item.activePaneId === paneId
              ? flattenPanes(layout)[0]!.id
              : item.activePaneId,
          }
        : item)
      : tabs.filter((item) => item.id !== tabId);
    persistTabs(next);
    setPaneRuntime((current) => {
      const updated = { ...current };
      delete updated[paneId];
      return updated;
    });
    setQuickAiPaneId((current) => current === paneId ? undefined : current);
    if (!layout && activeId === tabId) {
      setActiveId(next[Math.min(Math.max(tabIndex, 0), next.length - 1)]?.id ?? "");
    }
  }, [activeId, persistTabs, t, tabs]);

  const closeTerminal = useCallback(async (tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const paneIds = flattenPanes(tab.layout).map((pane) => pane.id);
    const responses = await Promise.all(paneIds.map((paneId) =>
      fetch(`/v1/terminal-sessions/${paneId}`, { method: "DELETE" })));
    const failed = responses.find((response) => !response.ok && response.status !== 404);
    if (failed) {
      const payload = await failed.json().catch(() => ({})) as Record<string, unknown>;
      setWorkspaceError(apiError(payload, t("无法关闭终端"), t));
      return;
    }
    const index = tabs.findIndex((item) => item.id === tabId);
    const next = tabs.filter((item) => item.id !== tabId);
    persistTabs(next);
    setPaneRuntime((current) => {
      const updated = { ...current };
      for (const paneId of paneIds) delete updated[paneId];
      return updated;
    });
    setQuickAiPaneId((current) => current && paneIds.includes(current) ? undefined : current);
    if (activeId === tabId) {
      setActiveId(next[Math.min(Math.max(index, 0), next.length - 1)]?.id ?? "");
    }
  }, [activeId, persistTabs, t, tabs]);

  const splitTerminal = useCallback(async (
    target: TerminalContextMenuState,
    direction: SplitDirection,
  ) => {
    setSplitMenu(undefined);
    setWorkspaceError(undefined);
    try {
      const sourceTab = tabs.find((tab) => tab.id === target.tabId);
      const sourcePane = sourceTab ? findPane(sourceTab.layout, target.paneId) : undefined;
      const sourceRequest = sourcePane?.createRequest;
      if (!sourceRequest) {
        throw new Error(t("旧版恢复的远程会话无法复制分栏，请新建连接。"));
      }
      const sourceKind = isTerminalKind(sourceRequest.kind) ? sourceRequest.kind : "local";
      const pane = await createTerminalSession(
        { ...sourceRequest, cols: 100, rows: 28 },
        sourceKind === "local" ? "PowerShell" : sourcePane?.title ?? sourceKind.toUpperCase(),
        sourceKind,
      );
      const next = tabs.map((tab) => tab.id === target.tabId
        ? {
            ...tab,
            layout: splitPane(tab.layout, target.paneId, pane, direction),
            activePaneId: pane.id,
          }
        : tab);
      persistTabs(next);
      setActiveId(target.tabId);
    } catch (reason) {
      setWorkspaceError(errorMessage(reason, t));
    }
  }, [createTerminalSession, persistTabs, t, tabs]);

  const activeTab = tabs.find((tab) => tab.id === activeId);
  const activePane = activeTab
    ? findPane(activeTab.layout, activeTab.activePaneId) ?? flattenPanes(activeTab.layout)[0]
    : undefined;
  const assistant = useAssistantController(activePane?.id ?? "");
  const activeRuntime = activePane
    ? paneRuntime[activePane.id] ?? connectingRuntime(t("正在附着终端"))
    : connectingRuntime(t("正在创建终端"));
  const context = activeRuntime.context;
  const writable = activeRuntime.writable;
  const detail = localizedKnownText(workspaceError ?? activeRuntime.detail, locale);
  const activePaneCount = activeTab ? flattenPanes(activeTab.layout).length : 0;
  const splitSource = splitMenu
    ? tabs.find((tab) => tab.id === splitMenu.tabId)?.layout
    : undefined;
  const splitSourcePane = splitMenu && splitSource
    ? findPane(splitSource, splitMenu.paneId)
    : undefined;
  const splitRequestKind = isTerminalKind(splitSourcePane?.createRequest?.kind)
    ? splitSourcePane.createRequest.kind
    : "local";
  const splitUnavailable = splitSourcePane?.createRequest === undefined;
  const splitTargetDescription = splitUnavailable
    ? t("旧版恢复会话 · 请新建连接")
    : splitRequestKind === "docker"
      ? t("同一 Docker 目标 · 重新核验")
      : splitRequestKind === "ssh"
        ? t("同一 SSH 目标 · 重新核验")
        : t("新 PowerShell");
  const splitCommandId = splitMenu
    ? paneRuntime[splitMenu.paneId]?.context?.recentCommandIds.at(-1)
    : undefined;

  const askAboutCommand = useCallback((paneId: string, prompt: string, commandId?: string) => {
    setSplitMenu(undefined);
    setQuickAiPaneId(paneId);
    if (assistant.providerReady) {
      void assistant.send(prompt, commandId ? [commandId] : undefined, paneId);
    } else {
      assistant.setMessage(prompt, paneId);
    }
  }, [assistant]);

  return (
    <main className={`workbench ${aiOpen ? "with-ai" : ""}`}>
      <nav className="activity-rail" aria-label={t("工作台导航")}>
        <div className="rail-brand" title="StackBridge">S</div>
        <button className="rail-button active" title={t("终端")} aria-label={t("终端")}>
          <AppIcon name="terminal" />
        </button>
        <button className="rail-button" title={t("新建连接")} aria-label={t("新建连接")} onClick={() => setConnectionOpen(true)}>
          <AppIcon name="connection" />
        </button>
        <button className={`rail-button ${aiOpen ? "active" : ""}`} title={t("AI 助手")} aria-label={t("AI 助手")} onClick={() => setAiOpen((value) => !value)}>
          <AppIcon name="spark" />
        </button>
        <div className="rail-spacer" />
        <button className="rail-button" title={t("设置")} aria-label={t("设置")} onClick={() => setSettingsOpen(true)}>
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
                  {tab.id === activeId ? (
                    <small>{flattenPanes(tab.layout).length > 1
                      ? `${flattenPanes(tab.layout).length} PANES`
                      : tab.kind === "local" ? "LOCAL" : tab.kind.toUpperCase()}</small>
                  ) : null}
                </button>
                <button
                  className="terminal-tab-close"
                  aria-label={locale === "zh-CN" ? `关闭 ${tab.title}` : `Close ${tab.title}`}
                  title={t("关闭终端")}
                  onClick={() => void closeTerminal(tab.id)}
                >×</button>
              </div>
            ))}
            <button className="new-tab-button" title={t("新建本地终端")} onClick={() => void addTerminal({ cols: 120, rows: 32, kind: "local" }, "PowerShell", "local")}>＋</button>
          </div>
        </header>

        <section className="terminal-area">
          {activeTab ? (
            <div className="terminal-layout">
              <TerminalLayoutView
                layout={activeTab.layout}
                tab={activeTab}
                activePaneCount={activePaneCount}
                paneRuntime={paneRuntime}
                quickAiPaneId={quickAiPaneId}
                assistant={assistant}
                shortcut={shortcut}
                paneElements={paneElements.current}
                cursorAnchors={cursorAnchors.current}
                onActivatePane={activatePane}
                onOpenMenu={setSplitMenu}
                onPaneElement={handlePaneElement}
                onContext={handleTerminalContext}
                onState={handleTerminalState}
                onCursorAnchor={handleCursorAnchor}
                onClosePane={(tabId, paneId) => void closePane(tabId, paneId)}
                onQuickAskClose={() => {
                  setQuickAiPaneId(undefined);
                  window.dispatchEvent(new Event("stackbridge:terminal-focus"));
                }}
                onQuickAskHistory={() => {
                  setQuickAiPaneId(undefined);
                  setAiOpen(true);
                }}
              />
            </div>
          ) : <CenteredStatus message={t("正在准备终端…")} />}
          <footer className="terminal-status">
            <span className={writable ? "writable" : ""}>{writable ? "● INPUT" : "○ READ ONLY"}</span>
            <span>{detail}</span>
            <span>SESSION {activePane ? activePane.id.slice(0, 8).toUpperCase() : "—"}</span>
          </footer>
        </section>
      </section>

      {aiOpen && activePane ? (
        <AssistantPanel
          assistant={assistant}
          context={context}
          shortcut={shortcut}
          onClose={() => {
            setAiOpen(false);
            window.dispatchEvent(new Event("stackbridge:terminal-focus"));
          }}
        />
      ) : null}

      {splitMenu ? (
        <TerminalContextMenu
          menu={splitMenu}
          commandId={splitCommandId}
          splitTargetDescription={splitTargetDescription}
          splitUnavailable={splitUnavailable}
          onAsk={askAboutCommand}
          onSplit={(target, direction) => void splitTerminal(target, direction)}
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
          locale={locale}
          onLocaleChange={setLocale}
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

function CenteredStatus({ message }: { message: string }) {
  return <div className="centered-status"><span className="spinner" /><p>{message}</p></div>;
}
