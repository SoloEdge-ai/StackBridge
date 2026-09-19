import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { matchesBrowserShortcut } from "../desktop/quick-ask-shortcut.js";
import { useLanguage } from "../i18n.js";
import { decodeServerMessage } from "./terminal-stream.js";
import type { ConnectionState, TerminalContext, TerminalCursorAnchor } from "./types.js";

function createXtermCursorAnchor(host: HTMLElement): TerminalCursorAnchor {
  return {
    getCursorRect() {
      return host.querySelector<HTMLElement>(".xterm-cursor")?.getBoundingClientRect();
    },
    observe(listener) {
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) return () => {};
      const observer = new MutationObserver(listener);
      observer.observe(screen, {
        attributes: true,
        attributeFilter: ["class", "style"],
        childList: true,
        subtree: true,
      });
      return () => observer.disconnect();
    },
  };
}

export function TerminalPane({
  sessionId,
  active,
  onContext,
  onState,
  onCursorAnchor,
  onUnavailable,
  quickAskShortcut,
}: {
  sessionId: string;
  active: boolean;
  onContext(sessionId: string, context: TerminalContext): void;
  onState(sessionId: string, state: ConnectionState, writable: boolean, detail: string): void;
  onCursorAnchor(sessionId: string, anchor: TerminalCursorAnchor | undefined): void;
  onUnavailable(): void;
  quickAskShortcut: string;
}) {
  const { t } = useLanguage();
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const activeRef = useRef(active);
  const onContextRef = useRef(onContext);
  const onStateRef = useRef(onState);
  const onCursorAnchorRef = useRef(onCursorAnchor);
  const onUnavailableRef = useRef(onUnavailable);
  const tRef = useRef(t);
  const quickAskShortcutRef = useRef(quickAskShortcut);

  useEffect(() => {
    onContextRef.current = onContext;
    onStateRef.current = onState;
    onCursorAnchorRef.current = onCursorAnchor;
    onUnavailableRef.current = onUnavailable;
    tRef.current = t;
    quickAskShortcutRef.current = quickAskShortcut;
  }, [onContext, onCursorAnchor, onState, onUnavailable, quickAskShortcut, t]);

  useEffect(() => {
    activeRef.current = active;
    if (active) terminalRef.current?.focus();
  }, [active]);

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
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && matchesBrowserShortcut(event, quickAskShortcutRef.current)) return false;
      return true;
    });
    terminal.open(host);
    terminalRef.current = terminal;
    onCursorAnchorRef.current(sessionId, createXtermCursorAnchor(host));
    fit.fit();
    if (activeRef.current) terminal.focus();
    let disposed = false;
    let socket: WebSocket | undefined;
    let canWrite = false;
    let replaying = false;
    let unavailableReported = false;
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
    const focus = () => {
      if (activeRef.current) terminal.focus();
    };
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
          onStateRef.current(sessionId, decoded.state, decoded.writable, decoded.state === "running" ? tRef.current("已连接真实 PTY") : tRef.current("Shell 已退出"));
          if (decoded.writable) {
            socket?.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
            if (activeRef.current) terminal.focus();
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
        onStateRef.current(sessionId, "running", canWrite, canWrite ? tRef.current("当前页面持有写入租约") : tRef.current("另一页面持有写入租约"));
      } else if (decoded.type === "exit") {
        canWrite = false;
        onStateRef.current(sessionId, "exited", false, `${tRef.current("Shell 已退出")} (${decoded.exitCode})`);
      } else terminal.writeln(`\r\n[StackBridge] ${decoded.message}`);
    });
    socket.addEventListener("close", (event) => {
      if (disposed) return;
      canWrite = false;
      if (event.code === 1006) onStateRef.current(sessionId, "unavailable", false, tRef.current("与 Core 的连接中断"));
    });
    socket.addEventListener("error", () => onStateRef.current(sessionId, "unavailable", false, tRef.current("终端连接失败")));

    const updateContext = async () => {
      try {
        const response = await fetch(`/v1/terminal-sessions/${sessionId}/context`, { cache: "no-store" });
        if (response.status === 404) {
          if (!unavailableReported) {
            unavailableReported = true;
            onUnavailableRef.current();
          }
          return;
        }
        if (response.ok) onContextRef.current(sessionId, await response.json() as TerminalContext);
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
      terminalRef.current = undefined;
      onCursorAnchorRef.current(sessionId, undefined);
    };
  }, [sessionId]);
  return <div className="terminal-host" ref={hostRef} />;
}
