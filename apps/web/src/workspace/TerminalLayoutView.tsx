import type { ReactNode } from "react";

import type { AssistantController } from "../assistant/use-assistant-controller.js";
import { InlineAssistant } from "../assistant/InlineAssistant.js";
import { localizedEnvironmentLabel, useLanguage } from "../i18n.js";
import { TerminalPane } from "../terminal/TerminalPane.js";
import {
  connectingRuntime,
  type ConnectionState,
  type PaneRuntimeState,
  type TerminalContext,
  type TerminalCursorAnchor,
} from "../terminal/types.js";
import type { TerminalContextMenuState } from "./TerminalContextMenu.js";
import type { PaneLayout, TerminalTab } from "./terminal-layout.js";

interface TerminalLayoutViewProps {
  layout: PaneLayout;
  tab: TerminalTab;
  activePaneCount: number;
  paneRuntime: Record<string, PaneRuntimeState>;
  quickAiPaneId: string | undefined;
  assistant: AssistantController;
  shortcut: string;
  paneElements: Map<string, HTMLElement>;
  cursorAnchors: Map<string, TerminalCursorAnchor>;
  onActivatePane(tabId: string, paneId: string): void;
  onOpenMenu(menu: TerminalContextMenuState): void;
  onPaneElement(sessionId: string, element: HTMLElement | null): void;
  onContext(sessionId: string, context: TerminalContext): void;
  onState(sessionId: string, state: ConnectionState, canWrite: boolean, message: string): void;
  onCursorAnchor(sessionId: string, anchor: TerminalCursorAnchor | undefined): void;
  onClosePane(tabId: string, paneId: string): void;
  onQuickAskClose(): void;
  onQuickAskHistory(): void;
}

export function TerminalLayoutView(props: TerminalLayoutViewProps) {
  const { locale, t } = useLanguage();

  const renderLayout = (layout: PaneLayout): ReactNode => {
    if (layout.type === "split") {
      return (
        <div className={`terminal-split ${layout.direction}`}>
          {renderLayout(layout.first)}
          {renderLayout(layout.second)}
        </div>
      );
    }
    const pane = layout.pane;
    const isActive = pane.id === props.tab.activePaneId;
    const runtime = props.paneRuntime[pane.id] ?? connectingRuntime(t("正在附着终端"));
    const paneContext = runtime.context;
    const paneBreadcrumb = paneContext?.environmentStack
      .map((item) => localizedEnvironmentLabel(item.label, item.kind, locale))
      .join(" → ") ?? t("正在识别环境");
    return (
      <section
        key={pane.id}
        ref={(element) => props.onPaneElement(pane.id, element)}
        className={`terminal-pane-shell ${isActive ? "active" : ""}`}
        data-terminal-session-id={pane.id}
        role="group"
        aria-label={t("终端窗格")}
        onPointerDownCapture={() => props.onActivatePane(props.tab.id, pane.id)}
        onFocusCapture={() => props.onActivatePane(props.tab.id, pane.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onActivatePane(props.tab.id, pane.id);
          props.onOpenMenu({
            tabId: props.tab.id,
            paneId: pane.id,
            x: Math.min(event.clientX, window.innerWidth - 224),
            y: Math.min(event.clientY, window.innerHeight - 246),
          });
        }}
      >
        <header className="terminal-pane-context">
          <div className="environment-main">
            <span className={`status-dot ${runtime.connectionState}`} />
            <strong title={paneBreadcrumb}>{paneBreadcrumb}</strong>
            {paneContext === undefined
              ? <span className="detecting-pill" title={t("正在识别环境")}>…</span>
              : paneContext.environment.verified
                ? <span className="verified-pill" title={t("环境已核验")}>✓</span>
                : <span className="warning-pill" title={t("环境未核验")}>!</span>}
          </div>
          <div className="environment-meta">
            <code title={paneContext?.cwd}>{paneContext?.cwd || "—"}</code>
            <span>{paneContext?.shell || "—"}</span>
          </div>
          {props.activePaneCount > 1 ? (
            <button
              className="terminal-pane-close"
              aria-label={locale === "zh-CN" ? `关闭 ${pane.title} 分栏` : `Close ${pane.title} split`}
              title={t("关闭这个分栏")}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => props.onClosePane(props.tab.id, pane.id)}
            >×</button>
          ) : null}
        </header>
        <TerminalPane
          sessionId={pane.id}
          active={isActive}
          onContext={props.onContext}
          onState={props.onState}
          onCursorAnchor={props.onCursorAnchor}
          onUnavailable={() => props.onClosePane(props.tab.id, pane.id)}
          quickAskShortcut={props.shortcut}
          attachments={(props.assistant.viewedAttachments ?? (isActive ? props.assistant.contextPreview?.attachments : []) ?? []).filter((item) => item.terminalSessionId === pane.id)}
          contextCommands={isActive ? props.assistant.contextPreview?.commands ?? [] : []}
          manualContext={props.assistant.contextSelection.contextMode === "manual"}
          contextDisabled={props.assistant.sending || !!props.assistant.viewedAttachments}
          onContextSelect={(commandIds) => props.assistant.setContextSelection({ contextMode: "manual", commandIds })}
        />
        {props.quickAiPaneId === pane.id ? (
          <InlineAssistant
            assistant={props.assistant}
            context={paneContext}
            paneElement={props.paneElements.get(pane.id)}
            cursorAnchor={props.cursorAnchors.get(pane.id)}
            onClose={props.onQuickAskClose}
            onOpenHistory={props.onQuickAskHistory}
          />
        ) : null}
      </section>
    );
  };

  return <>{renderLayout(props.layout)}</>;
}
