import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { localizedEnvironmentLabel, useLanguage } from "../i18n.js";
import type { TerminalContext, TerminalCursorAnchor } from "../terminal/types.js";
import { ProposalCard } from "./AssistantPanel.js";
import { ContextPicker } from "./ContextPicker.js";
import { useFloatingAssistant } from "./use-floating-assistant.js";
import type { AssistantController } from "./use-assistant-controller.js";

interface QuickAskAnchor {
  left: number;
  top: number;
  width: number;
  placement: "above" | "below";
}

const quickAskGutter = 12;
const quickAskCursorGap = 8;
const quickAskCompactWidth = 420;
const quickAskExpandedWidth = 520;
const quickAskFallbackCursorOffset = 80;
const quickAskFallbackCursorHeight = 19;
const quickAskTopFloor = 34;

function useTerminalCursorAnchor(
  rootRef: RefObject<HTMLElement | null>,
  pane: HTMLElement | undefined,
  cursorAnchor: TerminalCursorAnchor | undefined,
  expanded: boolean,
): QuickAskAnchor {
  const [anchor, setAnchor] = useState<QuickAskAnchor>({
    left: quickAskGutter,
    top: 40,
    width: quickAskCompactWidth,
    placement: "below",
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !pane) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const paneRect = pane.getBoundingClientRect();
        const cursorRect = cursorAnchor?.getCursorRect();
        const preferredWidth = expanded ? quickAskExpandedWidth : quickAskCompactWidth;
        const width = Math.min(preferredWidth, Math.max(0, paneRect.width - (quickAskGutter * 2)));
        const height = root.getBoundingClientRect().height;
        const cursorLeft = cursorRect?.left ?? paneRect.left + quickAskGutter;
        const cursorTop = cursorRect?.top ?? paneRect.bottom - quickAskFallbackCursorOffset;
        const cursorBottom = cursorRect?.bottom ?? cursorTop + quickAskFallbackCursorHeight;
        const left = Math.max(
          quickAskGutter,
          Math.min(
            cursorLeft - paneRect.left - quickAskCursorGap,
            paneRect.width - width - quickAskGutter,
          ),
        );
        const belowTop = cursorBottom - paneRect.top + quickAskCursorGap;
        const fitsBelow = belowTop + height <= paneRect.height - quickAskGutter;
        const placement = fitsBelow ? "below" : "above";
        const top = fitsBelow
          ? belowTop
          : Math.max(quickAskTopFloor, cursorTop - paneRect.top - height - quickAskCursorGap);
        setAnchor((current) => (
          Math.abs(current.left - left) < 1
          && Math.abs(current.top - top) < 1
          && Math.abs(current.width - width) < 1
          && current.placement === placement
            ? current
            : { left, top, width, placement }
        ));
      });
    };
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(root);
    resizeObserver.observe(pane);
    const stopObservingCursor = cursorAnchor?.observe(update);
    window.addEventListener("resize", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      stopObservingCursor?.();
      window.removeEventListener("resize", update);
    };
  }, [cursorAnchor, expanded, pane, rootRef]);

  return anchor;
}

export function InlineAssistant({
  assistant,
  context,
  paneElement,
  cursorAnchor,
  onClose,
  onOpenHistory,
}: {
  assistant: AssistantController;
  context: TerminalContext | undefined;
  paneElement: HTMLElement | undefined;
  cursorAnchor: TerminalCursorAnchor | undefined;
  onClose(): void;
  onOpenHistory(): void;
}) {
  const { locale, t } = useLanguage();
  const rootRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (assistant.providerReady) inputRef.current?.focus();
  }, [assistant.providerReady]);
  const environment = context
    ? context.environmentStack.map((item) => localizedEnvironmentLabel(item.label, item.kind, locale)).join(" → ")
    : t("正在识别环境");
  const latestAssistantMessage = assistant.inlineAssistantMessage;
  const proposals = latestAssistantMessage?.proposalIds?.flatMap((id) => {
    const proposal = assistant.conversation?.proposals.find((item) => item.id === id);
    return proposal ? [proposal] : [];
  }) ?? [];
  const turnPendingHere = assistant.sending
    && assistant.pendingTerminalId === context?.terminalSessionId;
  const expanded = !!latestAssistantMessage || turnPendingHere
    || (assistant.error !== undefined && assistant.errorTerminalId === context?.terminalSessionId);
  const anchor = useTerminalCursorAnchor(rootRef, paneElement, cursorAnchor, expanded);
  const floating = useFloatingAssistant(context?.terminalSessionId ?? "", paneElement, rootRef);
  const contextSummary = `${environment} · ${context?.cwd || "—"} · ${context?.shell || "—"}`;

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "30px";
    input.style.height = `${Math.min(66, Math.max(30, input.scrollHeight))}px`;
  }, [assistant.message]);

  const placementProps = {
    ref: rootRef,
    style: { left: anchor.left, top: anchor.top, width: anchor.width, ...floating.style },
    "data-placement": floating.fixed ? "fixed" : anchor.placement,
  } as const;
  if (!assistant.activeProvider) {
    return (
      <section {...placementProps} className="inline-assistant compact" aria-label={t("快速询问 AI")}>
        <div className="inline-ask-row"><span className="inline-ai-mark">✦</span><strong>{t("正在连接 AI 提供方…")}</strong><button type="button" className="icon-button" aria-label={t("关闭快速询问")} onClick={onClose}>×</button></div>
      </section>
    );
  }
  if (!assistant.providerReady) {
    return (
      <section {...placementProps} className="inline-assistant compact" aria-label={t("快速询问 AI")}>
        <div className="inline-ask-row">
          <span className="inline-ai-mark">✦</span><strong>{assistant.providerId === "chatgpt" ? t("需要先使用 ChatGPT 登录") : t("需要先配置 AI 提供方")}</strong>
          <button type="button" className="primary-button compact" onClick={assistant.providerId === "chatgpt" ? () => void assistant.login() : onOpenHistory}>{assistant.providerId === "chatgpt" ? t("使用 ChatGPT 登录") : t("配置 DeepSeek")}</button>
          <button type="button" className="icon-button" aria-label={t("关闭快速询问")} onClick={onClose}>×</button>
        </div>
      </section>
    );
  }
  return (
    <section {...placementProps} className="inline-assistant" aria-label={t("快速询问 AI")}>
      <div className="quick-ask-drag-bar" aria-label="Move Quick Ask" onPointerDown={(event) => floating.begin(event, "move")}>
        <span>⠿ Quick Ask</span>
        {floating.fixed ? <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={floating.reset}>{locale === "zh-CN" ? "返回光标旁" : "Follow cursor"}</button> : null}
      </div>
      <ContextPicker assistant={assistant} context={context} />
      <button type="button" className="quick-ask-resize" aria-label="Resize Quick Ask" onPointerDown={(event) => floating.begin(event, "resize")} />
      <div className="inline-ask-row">
        <button
          type="button"
          className={`inline-context-indicator ${context?.environment.verified ? "verified" : "unverified"}`}
          title={contextSummary}
          aria-label={t("检查上下文")}
          onClick={onOpenHistory}
        />
        <textarea
          ref={inputRef}
          value={assistant.message}
          onChange={(event) => assistant.setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void assistant.send();
            }
          }}
          placeholder={t("问当前命令、输出或下一步…")}
          disabled={turnPendingHere}
          rows={1}
        />
        {turnPendingHere
          ? <button type="button" className="danger-button compact" onClick={assistant.stop}>{t("停止")}</button>
          : <button type="button" className="send-button" disabled={!assistant.message.trim() || assistant.sending} onClick={() => void assistant.send()}>↑</button>}
      </div>
      {latestAssistantMessage ? (
        <div className="inline-ai-response">
          <div className="message-role">
            <span>AI</span>
            <button type="button" className="inline-history-button" aria-label={t("历史与详情")} title={t("历史与详情")} onClick={onOpenHistory}>↗</button>
          </div>
          <div className="message-body">{latestAssistantMessage.content}</div>
          {proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              onDecision={(item, decision) => void assistant.decide(item, decision)}
              onExplain={(commandId) => void assistant.send(t("解释这条命令执行后的输出，并告诉我是否正常。"), [commandId])}
            />
          ))}
        </div>
      ) : null}
      {assistant.pendingMessage && assistant.pendingTerminalId === context?.terminalSessionId
        ? <div className="inline-ai-pending">{assistant.pendingMessage}</div>
        : null}
      {turnPendingHere
        ? <div className="thinking"><span /><span /><span /> {t("AI 正在分析当前终端…")}</div>
        : null}
      {assistant.error && assistant.errorTerminalId === context?.terminalSessionId
        ? <div className="panel-error">{assistant.error}</div>
        : null}
    </section>
  );
}
