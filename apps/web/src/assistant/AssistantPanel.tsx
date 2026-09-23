import { useEffect, useRef, useState } from "react";
import { ContextPicker, ProviderIdentity } from "./ContextPicker.js";
import { AssistantMarkdown } from "./AssistantMarkdown.js";
import { MessageAttachments } from "./MessageAttachments.js";
import {
  type AiProviderId,
  type CommandProposal,
  type DeepSeekProviderInput,
  type OperationSnapshot,
} from "@stackbridge/protocol";
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
  onQuickAsk,
}: {
  assistant: AssistantController;
  context: TerminalContext | undefined;
  shortcut: string;
  onClose(): void;
  onQuickAsk(): void;
}) {
  const { locale, t } = useLanguage();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [editingDeepSeek, setEditingDeepSeek] = useState(false);
  const {
    account,
    providers,
    providerId,
    activeProvider,
    models,
    model,
    conversation,
    conversations,
    message,
    pendingMessage,
    sending,
    error,
    loginId,
  } = assistant;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [conversation, pendingMessage]);
  useEffect(() => { if (assistant.providerReady) inputRef.current?.focus(); }, [assistant.providerReady]);

  if (!activeProvider || (providerId === "chatgpt" && !account)) {
    return <aside className="assistant-panel loading-panel"><PanelHeader title={t("AI 助手")} subtitle={shortcut} onClose={onClose} /><CenteredStatus message={t("正在连接 AI 提供方…")} /></aside>;
  }
  if (providerId === "chatgpt" && !account?.authenticated) {
    return (
      <aside className="assistant-panel">
        <PanelHeader title="Terminal AI" subtitle={shortcut} onClose={onClose} />
        <ProviderSwitcher
          providers={providers}
          value={providerId}
          disabled={!!conversation || sending}
          onChange={assistant.setProvider}
        />
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
          {account?.error ? <p className="form-error">{account.error}</p> : null}
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      </aside>
    );
  }
  if (providerId === "deepseek" && (!activeProvider.configured || editingDeepSeek)) {
    return (
      <aside className="assistant-panel">
        <PanelHeader title="Terminal AI" subtitle={shortcut} onClose={onClose} />
        <ProviderSwitcher
          providers={providers}
          value={providerId}
          disabled={!!conversation || sending}
          onChange={assistant.setProvider}
        />
        <DeepSeekSetup
          assistant={assistant}
          onDone={() => setEditingDeepSeek(false)}
          {...(activeProvider.configured
            ? { onCancel: () => setEditingDeepSeek(false) }
            : {})}
        />
      </aside>
    );
  }

  return (
    <aside className="assistant-panel">
      <PanelHeader title={t("AI 助手")} subtitle={providerId === "chatgpt" ? account?.accountLabel ?? shortcut : "DeepSeek API"} onClose={onClose} />
      <div className="conversation-toolbar">
      <button type="button" className="back-to-quick" onClick={onQuickAsk}>{locale === "zh-CN" ? "返回 Quick Ask" : "Back to Quick Ask"}</button>
      <button className="ghost-button compact" onClick={assistant.newConversation} disabled={sending}>＋ {t("新对话")}</button>
      {conversations.length ? <select aria-label={t("历史对话")} className="history-select" value={conversation?.id ?? ""} onChange={(event) => assistant.selectConversation(event.target.value)} disabled={sending}>
        <option value="">{t("历史对话")}</option>
        {conversations.map((item) => <option key={item.id} value={item.id}>[{item.providerId === "deepseek" ? "DeepSeek" : "ChatGPT"}] {localizedConversationTitle(item.title, locale)}</option>)}
      </select> : null}
      </div>
      <details className="model-settings">
      <summary><ProviderIdentity assistant={assistant} /><span>{locale === "zh-CN" ? "模型与连接" : "Model & connection"}</span></summary>
      <ProviderSwitcher
        providers={providers}
        value={providerId}
        disabled={!!conversation || sending}
        onChange={assistant.setProvider}
      />
      <div className="assistant-tools">
        {providerId === "deepseek" ? (
          <label className="model-input"><span>{t("模型")}</span><input list="deepseek-models" value={model} onChange={(event) => assistant.setModel(event.target.value)} disabled={!!conversation} /></label>
        ) : (
          <select aria-label={t("模型")} value={model} onChange={(event) => assistant.setModel(event.target.value)} disabled={!!conversation}>
            {(models.length ? models : [{ model: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" } as CodexModel]).map((item) => (
              <option key={item.model} value={item.model}>{item.displayName}</option>
            ))}
          </select>
        )}
        <datalist id="deepseek-models">{models.map((item) => <option key={item.model} value={item.model}>{item.displayName}</option>)}</datalist>
        {providerId === "deepseek" && !conversation ? <button className="text-button provider-configure" onClick={() => setEditingDeepSeek(true)}>{t("配置 DeepSeek")}</button> : null}
      </div>
      </details>
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
            {item.role === "assistant" ? <AssistantMarkdown content={item.content} /> : <div className="message-body">{item.role === "timeline" ? localizedSystemMessage(item.content, locale) : item.content}</div>}
            <MessageAttachments message={item} assistant={assistant} />
            {item.proposalIds?.map((id) => {
              const proposal = latestProposal(conversation.proposals, id);
              return proposal ? <ProposalCard key={proposal.id} proposal={proposal} busy={!!assistant.proposalBusy[proposal.id]} error={assistant.proposalErrors[proposal.id]} onRecheck={() => void assistant.recheck(proposal)} onDecision={(item, decision) => void assistant.decide(item, decision)} onExplain={(commandId) => void assistant.send(t("解释这条命令执行后的输出，并告诉我是否正常。"), [commandId])} /> : null;
            })}
          </div>
        ))}
        {pendingMessage ? <div className="message user pending"><div className="message-role">{t("你")}</div><div className="message-body">{pendingMessage}</div></div> : null}
        {sending ? <div className="thinking"><span /><span /><span /> {t("AI 正在分析当前终端…")}</div> : null}
      </div>
      {error ? <div className="panel-error">{error}</div> : null}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void assistant.send(); }}>
        <ContextPicker assistant={assistant} context={context} showProvider={false} />
        <textarea
          ref={inputRef}
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

function ProviderSwitcher({ providers, value, disabled, onChange }: {
  providers: Array<{ id: AiProviderId; label: string; available: boolean; configured: boolean }>;
  value: AiProviderId;
  disabled: boolean;
  onChange(value: AiProviderId): void;
}) {
  const { t } = useLanguage();
  return (
    <div className="provider-switcher" role="group" aria-label={t("AI 提供方")}>
      {(["chatgpt", "deepseek"] as const).map((providerId) => {
        const provider = providers.find((item) => item.id === providerId);
        return (
          <button
            key={providerId}
            type="button"
            className={value === providerId ? "active" : ""}
            aria-pressed={value === providerId}
            disabled={disabled}
            onClick={() => onChange(providerId)}
          >
            {providerId === "chatgpt" ? "ChatGPT" : "DeepSeek"}
            <span className={provider?.configured ? "ready" : provider?.available ? "idle" : "offline"} />
          </button>
        );
      })}
      {disabled ? <small>{t("新建对话后可切换提供方")}</small> : null}
    </div>
  );
}

function DeepSeekSetup({ assistant, onDone, onCancel }: {
  assistant: AssistantController;
  onDone(): void;
  onCancel?: () => void;
}) {
  const { t } = useLanguage();
  const provider = assistant.activeProvider;
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "https://api.deepseek.com");
  const [model, setModel] = useState(
    provider?.model ?? assistant.models.find((item) => item.isDefault)?.model ?? "",
  );
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "clear">();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const payload = (): DeepSeekProviderInput => ({
    schemaVersion: 2,
    baseUrl,
    model,
    ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
  });
  const endpointHost = (() => {
    try { return new URL(baseUrl).host; } catch { return baseUrl; }
  })();

  async function run(action: "test" | "save") {
    setBusy(action);
    setError(undefined);
    setStatus(undefined);
    try {
      if (action === "test") {
        await assistant.testDeepSeek(payload());
        setStatus(t("连接成功"));
      } else {
        await assistant.saveDeepSeek(payload());
        setApiKey("");
        onDone();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("请求失败"));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="account-empty deepseek-setup">
      <div className="ai-hero compact-hero">
        <div className="ai-orb"><SparkIcon /></div>
        <span className="ai-kicker">DEEPSEEK · RESPONSES API</span>
        <h2>{t("配置 DeepSeek API")}</h2>
        <p>{t("API Key 仅保存在本机，模型只能返回回答和待确认的命令建议。")}</p>
      </div>
      <label className="field"><span>{t("API 地址")}</span><input aria-label={t("API 地址")} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
      <label className="field"><span>{t("模型")}</span><input aria-label={t("模型")} list="deepseek-setup-models" value={model} onChange={(event) => setModel(event.target.value)} /></label>
      <datalist id="deepseek-setup-models">
        {assistant.models.map((item) => (
          <option key={item.model} value={item.model}>{item.displayName}</option>
        ))}
      </datalist>
      <label className="field"><span>API Key</span><input aria-label="API Key" type="password" value={apiKey} placeholder={provider?.hasApiKey ? t("留空以保留已保存的密钥") : "sk-…"} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" /></label>
      <p className="form-note">{t("密钥将发送到")} <strong>{endpointHost}</strong>。{provider?.credentialPersistence === "session-only" ? t("当前仅在本次会话中保存。") : t("密钥由 Windows 系统加密后保存。")}</p>
      <div className="provider-actions">
        <button className="ghost-button" disabled={!!busy} onClick={() => void run("test")}>{busy === "test" ? t("正在测试…") : t("测试连接")}</button>
        <button className="primary-button" disabled={!!busy} onClick={() => void run("save")}>{busy === "save" ? t("正在保存…") : t("保存并使用")}</button>
      </div>
      {onCancel ? <button className="text-button" onClick={onCancel}>{t("取消")}</button> : null}
      {provider?.configured ? <button className="text-button danger-text" disabled={!!busy} onClick={() => {
        setBusy("clear");
        void assistant.clearDeepSeek().then(onDone).catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : t("请求失败"));
        }).finally(() => setBusy(undefined));
      }}>{t("清除 DeepSeek 配置")}</button> : null}
      {status ? <p className="form-success">{status}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

function latestProposal(proposals: CommandProposal[], id: string): CommandProposal | undefined {
  const visited = new Set<string>();
  let proposal = proposals.find((item) => item.id === id);
  while (proposal?.replacementProposalId && !visited.has(proposal.id)) {
    visited.add(proposal.id);
    const next = proposals.find((item) => item.id === proposal!.replacementProposalId);
    if (!next) break;
    proposal = next;
  }
  return proposal;
}

export function ProposalCard({ proposal, busy, error, onRecheck, onDecision, onExplain }: {
  proposal: CommandProposal;
  busy: boolean;
  error: string | undefined;
  onRecheck(): void;
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
      {error || proposal.status === "stale" || proposal.status === "expired" ? <p className="proposal-notice" role="status">{error ?? t("终端状态已变化。重新检查原终端后，才能再次确认执行。")}</p> : null}
      {proposal.replacesProposalId && proposal.status === "pending" ? <p className="proposal-notice" role="status">{t("已重新检查。请核对命令与原执行目标，再确认执行。")}</p> : null}
      {proposal.status === "pending" ? (
        <div className="proposal-actions">
          <button className="primary-button compact" disabled={busy} onClick={() => onDecision(proposal, "execute")}>{t("在此终端执行")}</button>
          <button className="ghost-button compact" disabled={busy} onClick={() => onDecision(proposal, "insert")}>{t("放入输入行")}</button>
          <button className="text-button" disabled={busy} onClick={() => onDecision(proposal, "reject")}>{t("暂不执行")}</button>
        </div>
      ) : proposal.status === "stale" || proposal.status === "expired" ? <button type="button" className="ghost-button compact" disabled={busy} onClick={onRecheck}>{busy ? t("正在重新检查…") : t("重新检查并确认")}</button>
        : proposal.operationId ? <OperationTracker id={proposal.operationId} onExplain={onExplain} /> : null}
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
