import { useCallback, useEffect, useRef, useState } from "react";
import {
  conversationSnapshotSchema,
  type AiModel,
  type AiAccountStatus,
  type AiProviderId,
  type AiProviderSummary,
  type ApprovalDecisionRequest,
  type CommandProposal,
  type ConversationSnapshot,
  type DeepSeekProviderInput,
  type ContextSelection,
  type AssistantContextPreview,
  type TerminalContext,
  type TerminalAttachment,
} from "@stackbridge/protocol";
import { api, errorMessage } from "../api/client.js";
import { useLanguage } from "../i18n.js";

export type ApprovalDecision = ApprovalDecisionRequest["decision"];
export type ConversationMessage = ConversationSnapshot["messages"][number];

export type CodexModel = AiModel;

export interface AssistantController {
  account: AiAccountStatus | undefined;
  providers: AiProviderSummary[];
  providerId: AiProviderId;
  activeProvider: AiProviderSummary | undefined;
  providerReady: boolean;
  models: AiModel[];
  model: string;
  conversation: ConversationSnapshot | undefined;
  conversations: ConversationSnapshot[];
  message: string;
  contextSelection: ContextSelection;
  setContextSelection(value: ContextSelection): void;
  contextPreview: AssistantContextPreview | undefined;
  contextPreviewError: boolean;
  contextPreviewPending: boolean;
  viewedAttachments: TerminalAttachment[] | undefined;
  viewAttachments(value: TerminalAttachment[] | undefined): void;
  pendingMessage: string | undefined;
  pendingTerminalId: string | undefined;
  inlineAssistantMessage: ConversationMessage | undefined;
  sending: boolean;
  error: string | undefined;
  errorTerminalId: string | undefined;
  loginId: string | undefined;
  setModel(value: string): void;
  setProvider(value: AiProviderId): void;
  setMessage(value: string, terminalIdOverride?: string): void;
  selectConversation(id: string): void;
  newConversation(): void;
  refreshAccount(): Promise<void>;
  login(): Promise<void>;
  cancelLogin(): Promise<void>;
  refreshProviders(): Promise<void>;
  testDeepSeek(input: DeepSeekProviderInput): Promise<void>;
  saveDeepSeek(input: DeepSeekProviderInput): Promise<void>;
  clearDeepSeek(): Promise<void>;
  send(text?: string, commandIds?: string[], terminalIdOverride?: string): Promise<void>;
  decide(proposal: CommandProposal, decision: ApprovalDecision): Promise<void>;
  stop(): void;
}

type ConversationSelectionAction =
  | { type: "select"; id: string }
  | { type: "new" };

export function transitionConversationSelection(
  current: ConversationSnapshot | undefined,
  conversations: ConversationSnapshot[],
  sending: boolean,
  action: ConversationSelectionAction,
): ConversationSnapshot | undefined {
  if (sending) return current;
  return action.type === "new"
    ? undefined
    : conversations.find((item) => item.id === action.id);
}

export function useAssistantController(terminalId: string, terminalContext?: TerminalContext): AssistantController {
  const { t } = useLanguage();
  const [account, setAccount] = useState<AiAccountStatus>();
  const [providers, setProviders] = useState<AiProviderSummary[]>([]);
  const [providerId, setProviderId] = useState<AiProviderId>("chatgpt");
  const [models, setModels] = useState<AiModel[]>([]);
  const [model, setModel] = useState("gpt-5.6-luna");
  const [conversation, setConversation] = useState<ConversationSnapshot>();
  const [conversations, setConversations] = useState<ConversationSnapshot[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [contextSelections, setContextSelections] = useState<Record<string, ContextSelection>>({});
  const [contextPreview, setContextPreview] = useState<AssistantContextPreview>();
  const [contextPreviewError, setContextPreviewError] = useState(false);
  const [contextPreviewPending, setContextPreviewPending] = useState(true);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [viewedAttachments, viewAttachments] = useState<TerminalAttachment[]>();
  const contextSelection = contextSelections[terminalId] ?? { contextMode: "auto" };
  const [pendingMessage, setPendingMessage] = useState<string>();
  const [pendingTerminalId, setPendingTerminalId] = useState<string>();
  const [inlineMessageIds, setInlineMessageIds] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [errorTerminalId, setErrorTerminalId] = useState<string>();
  const [loginId, setLoginId] = useState<string>();
  const turnRequestVersion = useRef(0);
  const activeTurnConversationId = useRef<string | undefined>(undefined);
  const selectionKey = JSON.stringify(contextSelection);
  useEffect(() => {
    if (sending || !terminalId) return;
    const abort = new AbortController();
    setContextPreviewPending(true);
    setContextPreviewError(false);
    void fetch(`/v1/terminal-sessions/${terminalId}/ai-context`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
      body: JSON.stringify({ ...JSON.parse(selectionKey), prepare: true, ...(conversation ? { conversationId: conversation.id } : {}) }),
    }).then(async (response) => {
      if (!response.ok) throw new Error("Context preparation failed");
      const preview = await response.json() as AssistantContextPreview;
      if (!abort.signal.aborted) { setContextPreview(preview); setContextPreviewPending(false); }
    }).catch(() => { if (!abort.signal.aborted) { setContextPreviewError(true); setContextPreviewPending(false); setContextPreview(undefined); } });
    return () => abort.abort();
  }, [terminalId, terminalContext?.contextVersion, terminalContext?.outputSequence, conversation?.id, sending, selectionKey, previewRevision]);

  const refreshProviders = useCallback(async () => {
    const response = await fetch("/v1/ai/providers", { cache: "no-store" });
    if (!response.ok) return;
    setProviders(((await response.json()) as { data: AiProviderSummary[] }).data);
  }, []);
  const refreshAccount = useCallback(async () => {
    const response = await fetch("/v1/ai/account/status", { cache: "no-store" });
    setAccount(await response.json() as AiAccountStatus);
    await refreshProviders();
  }, [refreshProviders]);
  const refreshConversations = useCallback(async () => {
    const response = await fetch("/v1/conversations", { cache: "no-store" });
    if (response.ok) setConversations(((await response.json()) as { data: ConversationSnapshot[] }).data);
  }, []);

  useEffect(() => {
    void refreshAccount();
    void refreshProviders();
    void refreshConversations();
    void fetch("/v1/settings", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const settings = await response.json() as { aiProviderId?: AiProviderId };
      if (settings.aiProviderId) setProviderId(settings.aiProviderId);
    });
  }, [refreshAccount, refreshConversations, refreshProviders]);

  useEffect(() => {
    void fetch(`/v1/ai/models?providerId=${providerId}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const data = ((await response.json()) as { data: AiModel[] }).data;
      setModels(data);
      if (conversation?.providerId === providerId) {
        setModel(conversation.model);
        return;
      }
      const configured = providers.find((item) => item.id === providerId)?.model;
      const preferred = data.find((item) => item.model === configured)
        ?? data.find((item) => item.model === "gpt-5.6-luna")
        ?? data.find((item) => item.isDefault)
        ?? data[0];
      if (preferred) setModel(preferred.model);
    });
  }, [conversation?.id, conversation?.model, conversation?.providerId, providerId, providers]);

  const createConversation = useCallback(async (targetTerminalId: string, preparedContextId?: string): Promise<ConversationSnapshot> => {
    if (!targetTerminalId) throw new Error(t("正在准备终端…"));
    const created = await api<ConversationSnapshot>("/v1/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 2,
        terminalSessionId: targetTerminalId,
        providerId,
        model,
        ...(preparedContextId ? { preparedContextId } : {}),
      }),
    }, t);
    const parsed = conversationSnapshotSchema.parse(created);
    setConversation(parsed);
    await refreshConversations();
    return parsed;
  }, [model, providerId, refreshConversations, t]);

  async function login() {
    setError(undefined);
    setErrorTerminalId(undefined);
    try {
      const result = await api<{ loginId: string; authUrl: string }>("/v1/ai/account/login", { method: "POST" }, t);
      setLoginId(result.loginId);
      window.open(result.authUrl, "_blank", "noopener,noreferrer");
      const interval = window.setInterval(() => void refreshAccount(), 1_500);
      window.setTimeout(() => clearInterval(interval), 120_000);
    } catch (reason) {
      setError(errorMessage(reason, t));
    }
  }

  async function cancelLogin() {
    if (!loginId) return;
    setError(undefined);
    setErrorTerminalId(undefined);
    try {
      await api("/v1/ai/account/login/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginId }),
      }, t);
      setLoginId(undefined);
    } catch (reason) {
      setError(errorMessage(reason, t));
    }
  }

  async function testDeepSeek(input: DeepSeekProviderInput) {
    setError(undefined);
    await api("/v1/ai/providers/deepseek/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, t);
  }

  async function saveDeepSeek(input: DeepSeekProviderInput) {
    setError(undefined);
    await api("/v1/ai/providers/deepseek", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, t);
    setModel(input.model);
    await refreshProviders();
  }

  async function clearDeepSeek() {
    setError(undefined);
    await api("/v1/ai/providers/deepseek", { method: "DELETE" }, t);
    await refreshProviders();
  }

  const message = drafts[terminalId] ?? "";
  const inlineAssistantMessage = conversation?.messages.find(
    (item) => item.id === inlineMessageIds[terminalId] && item.role === "assistant",
  );
  async function send(text?: string, commandIds?: string[], terminalIdOverride?: string) {
    const targetTerminalId = terminalIdOverride ?? terminalId;
    const prompt = text ?? drafts[targetTerminalId] ?? "";
    if (!prompt.trim() || sending) return;
    if (!commandIds && (contextPreviewPending || !contextPreview?.preparedId || targetTerminalId !== terminalId)) {
      setError(t("正在准备终端…"));
      setPreviewRevision((value) => value + 1);
      return;
    }
    const requestVersion = ++turnRequestVersion.current;
    setSending(true);
    setError(undefined);
    setErrorTerminalId(undefined);
    setPendingMessage(prompt.trim());
    setPendingTerminalId(targetTerminalId);
    setDrafts((current) => ({ ...current, [targetTerminalId]: "" }));
    try {
      const prepared = commandIds ? await api<AssistantContextPreview>(`/v1/terminal-sessions/${targetTerminalId}/ai-context`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prepare: true, contextMode: "manual", commandIds, ...(conversation ? { conversationId: conversation.id } : {}) }),
      }, t) : contextPreview!;
      const current = conversation ?? await createConversation(targetTerminalId, prepared.preparedId);
      if (turnRequestVersion.current !== requestVersion) return;
      activeTurnConversationId.current = current.id;
      const updated = await api<ConversationSnapshot>(`/v1/conversations/${current.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 2, terminalSessionId: targetTerminalId, message: prompt.trim(), preparedContextId: prepared.preparedId }),
      }, t);
      const parsed = conversationSnapshotSchema.parse(updated);
      if (turnRequestVersion.current === requestVersion) {
        setConversation(parsed);
        const assistantMessage = [...parsed.messages].reverse().find((item) => item.role === "assistant");
        if (assistantMessage) {
          setInlineMessageIds((current) => ({ ...current, [targetTerminalId]: assistantMessage.id }));
        }
        await refreshConversations();
      }
    } catch (reason) {
      if (turnRequestVersion.current === requestVersion) {
        setError(errorMessage(reason, t));
        setDrafts((drafts) => ({ ...drafts, [targetTerminalId]: prompt }));
        setPreviewRevision((value) => value + 1);
        setErrorTerminalId(targetTerminalId);
      }
    } finally {
      if (turnRequestVersion.current === requestVersion) {
        setSending(false);
        setPendingMessage(undefined);
        setPendingTerminalId(undefined);
        activeTurnConversationId.current = undefined;
      }
    }
  }

  async function decide(proposal: CommandProposal, decision: ApprovalDecision) {
    setError(undefined);
    setErrorTerminalId(undefined);
    try {
      const result = await api<{ proposal: CommandProposal }>(`/v1/approvals/${proposal.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 2, decision }),
      }, t);
      setConversation((current) => current && ({
        ...current,
        proposals: current.proposals.map((item) => item.id === proposal.id ? result.proposal : item),
      }));
      if (decision === "insert") window.dispatchEvent(new Event("stackbridge:terminal-focus"));
    } catch (reason) {
      setError(errorMessage(reason, t));
      setErrorTerminalId(proposal.terminalSessionId);
      if (conversation) {
        const refreshed = await api<ConversationSnapshot>(`/v1/conversations/${conversation.id}`, undefined, t);
        setConversation(refreshed);
      }
    }
  }

  const activeProvider = providers.find((provider) => provider.id === providerId);
  const providerReady = providerId === "chatgpt"
    ? account?.authenticated === true
    : activeProvider?.configured === true;

  return {
    account,
    providers,
    providerId,
    activeProvider,
    providerReady,
    models,
    model,
    conversation,
    conversations,
    message,
    contextSelection,
    contextPreview,
    contextPreviewError,
    contextPreviewPending,
    viewedAttachments,
    viewAttachments,
    setContextSelection(value) {
      if (sending) return;
      setContextPreviewPending(true);
      viewAttachments(undefined);
      setContextSelections((current) => ({ ...current, [terminalId]: value }));
    },
    pendingMessage,
    pendingTerminalId,
    inlineAssistantMessage,
    sending,
    error,
    errorTerminalId,
    loginId,
    setModel,
    setProvider(value) {
      if (conversation || sending) return;
      setProviderId(value);
      void fetch("/v1/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ aiProviderId: value }),
      });
    },
    setMessage(value, terminalIdOverride) {
      const targetTerminalId = terminalIdOverride ?? terminalId;
      setDrafts((current) => ({ ...current, [targetTerminalId]: value }));
    },
    selectConversation(id) {
      if (sending) return;
      setContextPreview(undefined);
      viewAttachments(undefined);
      const selected = transitionConversationSelection(
        conversation,
        conversations,
        sending,
        { type: "select", id },
      );
      setConversation(selected);
      if (selected) {
        setProviderId(selected.providerId);
        setModel(selected.model);
      }
      setInlineMessageIds({});
    },
    newConversation() {
      if (sending) return;
      setContextPreview(undefined);
      viewAttachments(undefined);
      setConversation((current) => transitionConversationSelection(
        current,
        conversations,
        sending,
        { type: "new" },
      ));
      setInlineMessageIds({});
    },
    refreshAccount,
    refreshProviders,
    login,
    cancelLogin,
    testDeepSeek,
    saveDeepSeek,
    clearDeepSeek,
    send,
    decide,
    stop() {
      const conversationId = activeTurnConversationId.current ?? conversation?.id;
      turnRequestVersion.current += 1;
      if (pendingMessage && pendingTerminalId) {
        setDrafts((current) => ({ ...current, [pendingTerminalId]: pendingMessage }));
      }
      setSending(false);
      setPendingMessage(undefined);
      setPendingTerminalId(undefined);
      activeTurnConversationId.current = undefined;
      if (conversationId) void fetch(`/v1/conversations/${conversationId}/stop`, { method: "POST" });
    },
  };
}
