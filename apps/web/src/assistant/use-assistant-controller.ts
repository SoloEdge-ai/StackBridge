import { useCallback, useEffect, useRef, useState } from "react";
import {
  conversationSnapshotSchema,
  type AiAccountStatus,
  type ApprovalDecisionRequest,
  type CommandProposal,
  type ConversationSnapshot,
} from "@stackbridge/protocol";
import { api, errorMessage } from "../api/client.js";
import { useLanguage } from "../i18n.js";

export type ApprovalDecision = ApprovalDecisionRequest["decision"];
export type ConversationMessage = ConversationSnapshot["messages"][number];

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

export interface AssistantController {
  account: AiAccountStatus | undefined;
  models: CodexModel[];
  model: string;
  conversation: ConversationSnapshot | undefined;
  conversations: ConversationSnapshot[];
  message: string;
  pendingMessage: string | undefined;
  pendingTerminalId: string | undefined;
  inlineAssistantMessage: ConversationMessage | undefined;
  sending: boolean;
  error: string | undefined;
  errorTerminalId: string | undefined;
  loginId: string | undefined;
  setModel(value: string): void;
  setMessage(value: string, terminalIdOverride?: string): void;
  selectConversation(id: string): void;
  newConversation(): void;
  refreshAccount(): Promise<void>;
  login(): Promise<void>;
  cancelLogin(): Promise<void>;
  send(text?: string, commandIds?: string[], terminalIdOverride?: string): Promise<void>;
  decide(proposal: CommandProposal, decision: ApprovalDecision): Promise<void>;
  stop(): void;
}

export function canChangeConversation(sending: boolean): boolean {
  return !sending;
}

export function useAssistantController(terminalId: string): AssistantController {
  const { t } = useLanguage();
  const [account, setAccount] = useState<AiAccountStatus>();
  const [models, setModels] = useState<CodexModel[]>([]);
  const [model, setModel] = useState("gpt-5.6-luna");
  const [conversation, setConversation] = useState<ConversationSnapshot>();
  const [conversations, setConversations] = useState<ConversationSnapshot[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingMessage, setPendingMessage] = useState<string>();
  const [pendingTerminalId, setPendingTerminalId] = useState<string>();
  const [inlineMessageIds, setInlineMessageIds] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [errorTerminalId, setErrorTerminalId] = useState<string>();
  const [loginId, setLoginId] = useState<string>();
  const turnRequestVersion = useRef(0);
  const activeTurnConversationId = useRef<string | undefined>(undefined);

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
      const preferred = data.find((item) => item.model === "gpt-5.6-luna")
        ?? data.find((item) => item.isDefault)
        ?? data[0];
      if (preferred) setModel(preferred.model);
    });
  }, [refreshAccount, refreshConversations]);

  const createConversation = useCallback(async (targetTerminalId: string): Promise<ConversationSnapshot> => {
    if (!targetTerminalId) throw new Error(t("正在准备终端…"));
    const created = await api<ConversationSnapshot>("/v1/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 2, terminalSessionId: targetTerminalId, model }),
    }, t);
    const parsed = conversationSnapshotSchema.parse(created);
    setConversation(parsed);
    await refreshConversations();
    return parsed;
  }, [model, refreshConversations, t]);

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

  const message = drafts[terminalId] ?? "";
  const inlineAssistantMessage = conversation?.messages.find(
    (item) => item.id === inlineMessageIds[terminalId] && item.role === "assistant",
  );
  async function send(text?: string, commandIds?: string[], terminalIdOverride?: string) {
    const targetTerminalId = terminalIdOverride ?? terminalId;
    const prompt = text ?? drafts[targetTerminalId] ?? "";
    if (!prompt.trim() || sending) return;
    const requestVersion = ++turnRequestVersion.current;
    setSending(true);
    setError(undefined);
    setErrorTerminalId(undefined);
    setPendingMessage(prompt.trim());
    setPendingTerminalId(targetTerminalId);
    setDrafts((current) => ({ ...current, [targetTerminalId]: "" }));
    try {
      const current = conversation ?? await createConversation(targetTerminalId);
      if (turnRequestVersion.current !== requestVersion) return;
      activeTurnConversationId.current = current.id;
      const updated = await api<ConversationSnapshot>(`/v1/conversations/${current.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 2, terminalSessionId: targetTerminalId, message: prompt.trim(), ...(commandIds ? { commandIds } : {}) }),
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

  return {
    account,
    models,
    model,
    conversation,
    conversations,
    message,
    pendingMessage,
    pendingTerminalId,
    inlineAssistantMessage,
    sending,
    error,
    errorTerminalId,
    loginId,
    setModel,
    setMessage(value, terminalIdOverride) {
      const targetTerminalId = terminalIdOverride ?? terminalId;
      setDrafts((current) => ({ ...current, [targetTerminalId]: value }));
    },
    selectConversation(id) {
      if (!canChangeConversation(sending)) return;
      setConversation(conversations.find((item) => item.id === id));
      setInlineMessageIds({});
    },
    newConversation() {
      if (!canChangeConversation(sending)) return;
      setConversation(undefined);
      setInlineMessageIds({});
    },
    refreshAccount,
    login,
    cancelLogin,
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
