import { useEffect, useRef, useState } from "react";
import { type CommandProposal, type OperationSnapshot } from "@stackbridge/protocol";
import {
  localizedConversationTitle,
  localizedEnvironmentLabel,
  localizedSystemMessage,
  type MessageKey,
  useLanguage,
} from "../i18n.js";
import type { TerminalContext } from "../terminal/types.js";
import type { ApprovalDecision, AssistantController, CodexModel } from "./use-assistant-controller.js";

export function AssistantPanel({
  assistant,
  context,
  shortcut,
  onClose,
}: {
  assistant: AssistantController;
  context: TerminalContext | undefined;
  shortcut: string;
  onClose(): void;
}) {
  const { locale, t } = useLanguage();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { account, models, model, conversation, conversations, message, pendingMessage, sending, error, loginId } = assistant;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [conversation, pendingMessage]);

  if (!account) return <aside className="assistant-panel loading-panel"><PanelHeader title={t("AI 助手")} subtitle={shortcut} onClose={onClose} /><CenteredStatus message={t("正在连接 Codex…")} /></aside>;
  if (!account.authenticated) {
    return (
      <aside className="assistant-panel">
        <PanelHeader title="Terminal AI" subtitle={shortcut} onClose={onClose} />
        <div className="account-empty">
          <div className="ai-hero">
            <div className="ai-orb"><SparkIcon /></div>
            <span className="ai-kicker">CODEX · CONTEXT AWARE</span>
            <h2>{t("让终端自己解释终端")}</h2>
            <p>{t("直接询问刚才的命令和输出。StackBridge 会自动带上当前主机、容器、目录和 Shell。")}</p>
          </div>
          <div className="ai-capabilities">
            <div><span>01</span><p><strong>{t("理解现场")}</strong><small>{t("自动关联最近命令与输出")}</small></p></div>
            <div><span>02</span><p><strong>{t("给出命令")}</strong><small>{t("建议始终固定到当前环境")}</small></p></div>
            <div><span>03</span><p><strong>{t("确认再执行")}</strong><small>{t("每条命令都由你最终决定")}</small></p></div>
          </div>
          {loginId ? <>
            <p className="form-note">{t("授权页面已打开。完成后回到这里检查状态；若网络或地区不可用，可以取消后重试。")}</p>
            <button className="primary-button" onClick={() => void assistant.refreshAccount()}>{t("检查登录状态")}</button>
            <button className="ghost-button" onClick={() => void assistant.cancelLogin()}>{t("取消本次登录")}</button>
          </> : <button className="primary-button ai-login-button" onClick={() => void assistant.login()}>{t("使用 ChatGPT 登录")} <span>↗</span></button>}
          <p className="privacy-note">{t("登录凭据保存在 StackBridge 独立 Codex 数据目录的认证文件中。")}</p>
          {account.error ? <p className="form-error">{account.error}</p> : null}
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      </aside>
    );
  }

  return (
    <aside className="assistant-panel">
      <PanelHeader title={t("AI 助手")} subtitle={account.accountLabel ?? shortcut} onClose={onClose} />
      <div className="assistant-tools">
        <select value={model} onChange={(event) => assistant.setModel(event.target.value)} disabled={!!conversation}>
          {(models.length ? models : [{ model: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" } as CodexModel]).map((item) => (
            <option key={item.model} value={item.model}>{item.displayName}</option>
          ))}
        </select>
        <button className="ghost-button compact" onClick={assistant.newConversation} disabled={sending}>＋ {t("新对话")}</button>
        {conversations.length ? (
          <select className="history-select" value={conversation?.id ?? ""} onChange={(event) => assistant.selectConversation(event.target.value)} disabled={sending}>
            <option value="">{t("历史对话")}</option>
            {conversations.map((item) => <option key={item.id} value={item.id}>{localizedConversationTitle(item.title, locale)}</option>)}
          </select>
        ) : null}
      </div>
      <div className="context-chip-row">
        <span className={`context-chip ${context?.environment.verified === false ? "warning" : ""}`}>{context ? localizedEnvironmentLabel(context.environment.label, context.environment.kind, locale) : t("识别环境中")}</span>
        <span className="context-chip">{locale === "zh-CN" ? `附带最近 ${Math.min(3, context?.recentCommandIds.length ?? 0)} 条输出` : `Includes ${Math.min(3, context?.recentCommandIds.length ?? 0)} recent outputs`}</span>
        <details className="context-preview"><summary>{t("检查上下文")}</summary><pre>{JSON.stringify({
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
            <h3>{t("不用复制终端输出")}</h3>
            <p>{t("直接问“刚才的错误是什么意思？”或“这个命令怎么写？”。")}</p>
            <div className="prompt-suggestions">
              {(["解释刚才的输出", "给我一个安全的排查命令", "当前在哪个环境？"] as const).map((item) => (
                <button key={item} onClick={() => void assistant.send(t(item))}>{t(item)}</button>
              ))}
            </div>
          </div>
        ) : conversation.messages.map((item) => (
          <div key={item.id} className={`message ${item.role}`}>
            <div className="message-role">{item.role === "user" ? t("你") : item.role === "assistant" ? "AI" : t("环境")}</div>
            <div className="message-body">{item.role === "timeline" ? localizedSystemMessage(item.content, locale) : item.content}</div>
            {item.proposalIds?.map((id) => {
              const proposal = conversation.proposals.find((candidate) => candidate.id === id);
              return proposal ? <ProposalCard key={id} proposal={proposal} onDecision={(item, decision) => void assistant.decide(item, decision)} onExplain={(commandId) => void assistant.send(t("解释这条命令执行后的输出，并告诉我是否正常。"), [commandId])} /> : null;
            })}
          </div>
        ))}
        {pendingMessage ? <div className="message user pending"><div className="message-role">{t("你")}</div><div className="message-body">{pendingMessage}</div></div> : null}
        {sending ? <div className="thinking"><span /><span /><span /> {t("Codex 正在分析当前终端…")}</div> : null}
      </div>
      {error ? <div className="panel-error">{error}</div> : null}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void assistant.send(); }}>
        <textarea
          value={message}
          onChange={(event) => assistant.setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void assistant.send();
            }
          }}
          placeholder={t("问当前命令、输出或下一步…")}
          disabled={sending}
          rows={3}
        />
        <div className="composer-footer">
          <span>{t("Enter 发送 · Shift+Enter 换行")}</span>
          {sending ? <button type="button" className="danger-button" onClick={assistant.stop}>{t("停止")}</button> : <button className="send-button" disabled={!message.trim()}>{t("发送 ↑")}</button>}
        </div>
      </form>
    </aside>
  );
}

export function ProposalCard({ proposal, onDecision, onExplain }: {
  proposal: CommandProposal;
  onDecision(proposal: CommandProposal, decision: ApprovalDecision): void;
  onExplain(commandBlockId: string): void;
}) {
  const { locale, t } = useLanguage();
  return (
    <section className="proposal-card">
      <div className="proposal-heading"><span>{t("命令建议")}</span><StatusBadge status={proposal.status} /></div>
      <p>{proposal.purpose}</p>
      <pre><code>{proposal.command}</code></pre>
      <div className="proposal-target">
        <span>{localizedEnvironmentLabel(proposal.environmentLabel, proposal.environmentKind, locale)}</span>
        <span>{proposal.host ?? (proposal.environmentKind === "local" ? t("本机") : proposal.environmentKind)}</span>
        {proposal.containerId ? <span title={proposal.containerId}>{t("容器")} {proposal.containerId.slice(0, 12)}</span> : null}
        <span>{proposal.user || t("当前用户")}</span><span>{proposal.cwd || t("当前目录")}</span><span>{proposal.shell}</span>
      </div>
      {proposal.status === "pending" ? (
        <div className="proposal-actions">
          <button className="primary-button compact" onClick={() => onDecision(proposal, "execute")}>{t("在此终端执行")}</button>
          <button className="ghost-button compact" onClick={() => onDecision(proposal, "insert")}>{t("放入输入行")}</button>
          <button className="text-button" onClick={() => onDecision(proposal, "reject")}>{t("暂不执行")}</button>
        </div>
      ) : proposal.operationId ? <OperationTracker id={proposal.operationId} onExplain={onExplain} /> : null}
    </section>
  );
}

function OperationTracker({ id, onExplain }: { id: string; onExplain(commandBlockId: string): void }) {
  const { t } = useLanguage();
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
  if (!operation) return <div className="operation-row">{t("正在提交…")}</div>;
  return (
    <div className="operation-row">
      <StatusBadge status={operation.status} />
      {operation.exitCode !== undefined ? <span>{t("退出码")} {operation.exitCode}</span> : null}
      {operation.commandBlockId ? <button className="text-button" onClick={() => onExplain(operation.commandBlockId!)}>{t("解释结果")}</button> : null}
    </div>
  );
}

function SparkIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Zm6 11 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14Z" /></svg>;
}

function PanelHeader({ title, subtitle, onClose }: { title: string; subtitle: string; onClose(): void }) {
  return <header className="panel-header"><div><h2>{title}</h2><span>{subtitle}</span></div><button className="icon-button" onClick={onClose}>×</button></header>;
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useLanguage();
  const labels: Record<string, MessageKey> = {
    pending: "等待确认", accepted: "已提交", running: "执行中", completed: "完成",
    failed: "失败", interrupted: "已中断", unknown: "状态未知", inserted: "已放入输入行",
    rejected: "未执行", expired: "已过期", stale: "需要重新确认",
  };
  return <span className={`status-badge ${status}`}>{labels[status] ? t(labels[status]) : status}</span>;
}

function CenteredStatus({ message }: { message: string }) {
  return <div className="centered-status"><span className="spinner" /><p>{message}</p></div>;
}
