import { randomUUID } from "node:crypto";

import type {
  CommandProposal,
  ConversationMessage,
  ConversationSnapshot,
  CreateConversationRequest,
  CreateTurnRequest,
  AiProviderId,
  OperationSnapshot,
} from "@stackbridge/protocol";

import type {
  ApprovedCommandRequest,
  ExecutionOperation,
  TerminalContext,
  TerminalSessionManager,
} from "./terminal-session.js";
import type { ConversationPersistence } from "./workspace-store.js";

const proposalLifetimeMs = 5 * 60_000;
const maximumContextBytes = 64 * 1_024;

export interface AssistantCommandProposal {
  purpose: string;
  command: string;
}

export interface AgentEngineContext {
  terminalSessionId: string;
  environment: TerminalContext["environment"];
  environmentStack: TerminalContext["environmentStack"];
  cwd: string;
  shell: string;
  user: string;
  shellState: TerminalContext["shellState"];
  recentCommands: Array<{
    id: string;
    environmentFrameId: string;
    source: "manual" | "ai";
    command: string;
    cwd: string;
    exitCode?: number;
    output?: string;
    outputTruncated: boolean;
    captureQuality: "exact" | "screen" | "unknown";
  }>;
  contextTruncated: boolean;
}

export interface AgentEngine {
  startSession(model: string): Promise<string | undefined>;
  runTurn(input: {
    conversationId: string;
    providerSessionId?: string;
    model: string;
    message: string;
    history: ConversationMessage[];
    context: AgentEngineContext | null;
  }): Promise<{ answer: string; proposals: AssistantCommandProposal[] }>;
  stopTurn?(input: { conversationId: string; providerSessionId?: string }): Promise<void>;
}

export interface AgentEngineRouter {
  engine(providerId: AiProviderId): AgentEngine | undefined;
  defaultModel(providerId: AiProviderId): string;
}

interface ManagedConversation {
  snapshot: ConversationSnapshot;
}

interface FrozenProposal {
  proposal: CommandProposal;
  scope: ApprovedCommandRequest;
}

export class ConversationService {
  private readonly conversations = new Map<string, ManagedConversation>();
  private readonly proposals = new Map<string, FrozenProposal>();
  private readonly operations = new Map<string, OperationSnapshot>();
  private readonly lastEnvironmentByConversation = new Map<string, string>();

  constructor(
    private readonly terminals: TerminalSessionManager,
    private readonly engines: AgentEngine | AgentEngineRouter,
    private readonly now: () => Date = () => new Date(),
    private readonly persistence?: ConversationPersistence,
  ) {
    for (const snapshot of persistence?.loadConversations() ?? []) {
      this.conversations.set(snapshot.id, { snapshot });
    }
    for (const stored of persistence?.loadProposals() ?? []) {
      const conversation = this.conversations.get(stored.proposal.conversationId);
      const proposal = conversation?.snapshot.proposals.find(
        (candidate) => candidate.id === stored.proposal.id,
      );
      if (proposal === undefined) continue;
      Object.assign(proposal, stored.proposal);
      this.proposals.set(proposal.id, { proposal, scope: stored.scope });
    }
    for (const operation of persistence?.loadOperations() ?? []) {
      if (operation.status === "accepted" || operation.status === "running") {
        operation.status = "unknown";
        operation.updatedAt = this.now().toISOString();
        persistence?.saveOperation(operation);
      }
      this.operations.set(operation.id, operation);
    }
  }

  async create(input: CreateConversationRequest): Promise<ConversationSnapshot> {
    if (this.terminals.get(input.terminalSessionId) === undefined) {
      throw new ConversationTerminalNotFoundError();
    }
    const providerId = input.providerId ?? "chatgpt";
    const model = input.model ?? (
      "engine" in this.engines
        ? this.engines.defaultModel(providerId)
        : "gpt-5.6-luna"
    );
    const engine = this.requireEngine(providerId);
    const providerSessionId = await engine.startSession(model);
    const now = this.now().toISOString();
    const snapshot: ConversationSnapshot = {
      schemaVersion: 2,
      id: randomUUID(),
      title: "新对话",
      providerId,
      model,
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      createdAt: now,
      updatedAt: now,
      messages: [],
      proposals: [],
    };
    this.conversations.set(snapshot.id, { snapshot });
    this.persistence?.saveConversation(snapshot);
    return clone(snapshot);
  }

  list(): ConversationSnapshot[] {
    return [...this.conversations.values()]
      .map(({ snapshot }) => clone(snapshot))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  snapshot(id: string): ConversationSnapshot {
    const conversation = this.requireConversation(id);
    return clone(conversation.snapshot);
  }

  proposal(id: string): CommandProposal {
    return clone(this.requireProposal(id).proposal);
  }

  async turn(id: string, input: CreateTurnRequest): Promise<ConversationSnapshot> {
    const conversation = this.requireConversation(id);
    const engine = this.requireEngine(conversation.snapshot.providerId);
    const terminal = this.terminals.get(input.terminalSessionId);
    if (terminal === undefined) throw new ConversationTerminalNotFoundError();
    const frozen = terminal.context();
    const agentSessionId = randomUUID();
    const createdAt = this.now().toISOString();
    const environmentSignature = frozen.environmentStack
      .map((environment) => environment.bindingId ?? environment.id)
      .join("/");
    if (this.lastEnvironmentByConversation.get(id) !== environmentSignature) {
      const firstEnvironment = !this.lastEnvironmentByConversation.has(id);
      conversation.snapshot.messages.push({
        schemaVersion: 2,
        id: randomUUID(),
        role: "timeline",
        content: `${firstEnvironment ? "当前环境" : "切换到"}：${frozen.environmentStack.map((environment) => environment.label).join(" → ")}`,
        createdAt,
      });
      this.lastEnvironmentByConversation.set(id, environmentSignature);
    }
    const history = conversation.snapshot.messages.filter((message) => message.role !== "timeline").map((message) => clone(message));
    const userMessage: ConversationMessage = {
      schemaVersion: 2,
      id: randomUUID(),
      role: "user",
      content: input.message,
      createdAt,
      agentSessionId,
    };
    conversation.snapshot.messages.push(userMessage);
    conversation.snapshot.updatedAt = createdAt;
    if (conversation.snapshot.title === "新对话") {
      conversation.snapshot.title = input.message.slice(0, 36);
    }
    this.persistence?.saveConversation(conversation.snapshot);

    const result = await engine.runTurn({
      conversationId: conversation.snapshot.id,
      ...(conversation.snapshot.providerSessionId === undefined
        ? {}
        : { providerSessionId: conversation.snapshot.providerSessionId }),
      model: conversation.snapshot.model,
      message: input.message,
      history,
      context: input.contextMode === "none" ? null : buildAssistantContext(frozen, terminal.commands(), input.commandIds, input.contextMode),
    });
    const proposalIds: string[] = [];
    for (const candidate of result.proposals.slice(0, 8)) {
      if (candidate.command.trim() === "" || candidate.purpose.trim() === "") continue;
      const id = randomUUID();
      const proposal: CommandProposal = {
        schemaVersion: 2,
        id,
        conversationId: conversation.snapshot.id,
        agentSessionId,
        terminalSessionId: frozen.terminalSessionId,
        environmentFrameId: frozen.environment.id,
        environmentKind: frozen.environment.kind,
        environmentLabel: frozen.environment.label,
        ...(frozen.environment.host === undefined ? {} : { host: frozen.environment.host }),
        ...(frozen.environment.containerId === undefined
          ? {}
          : { containerId: frozen.environment.containerId }),
        ...(frozen.environment.bindingId === undefined
          ? {}
          : { bindingId: frozen.environment.bindingId }),
        purpose: candidate.purpose.trim(),
        command: candidate.command,
        cwd: frozen.cwd,
        shell: frozen.shell,
        user: frozen.user,
        createdAt,
        expiresAt: new Date(this.now().getTime() + proposalLifetimeMs).toISOString(),
        status: "pending",
      };
      const scope: ApprovedCommandRequest = {
        operationId: "",
        command: proposal.command,
        terminalSessionId: frozen.terminalSessionId,
        environmentFrameId: frozen.environment.id,
        bindingId: frozen.environment.bindingId,
        cwd: frozen.cwd,
        shell: frozen.shell,
        contextVersion: frozen.contextVersion,
        inputVersion: frozen.inputVersion,
      };
      this.proposals.set(id, { proposal, scope });
      conversation.snapshot.proposals.push(proposal);
      this.persistence?.saveProposal(proposal, scope);
      proposalIds.push(id);
    }
    const assistantMessage: ConversationMessage = {
      schemaVersion: 2,
      id: randomUUID(),
      role: "assistant",
      content: result.answer,
      createdAt: this.now().toISOString(),
      agentSessionId,
      ...(proposalIds.length === 0 ? {} : { proposalIds }),
    };
    conversation.snapshot.messages.push(assistantMessage);
    conversation.snapshot.updatedAt = assistantMessage.createdAt;
    this.persistence?.saveConversation(conversation.snapshot);
    return clone(conversation.snapshot);
  }

  decide(
    proposalId: string,
    decision: "execute" | "insert" | "reject",
  ): { proposal: CommandProposal; operation?: OperationSnapshot } {
    const frozen = this.requireProposal(proposalId);
    const proposal = frozen.proposal;
    if (proposal.status !== "pending") {
      const existing = proposal.operationId === undefined
        ? undefined
        : this.operation(proposal.operationId);
      return {
        proposal: clone(proposal),
        ...(existing === undefined ? {} : { operation: existing }),
      };
    }
    if (new Date(proposal.expiresAt).getTime() <= this.now().getTime()) {
      proposal.status = "expired";
      this.persistProposal(frozen);
      throw new ProposalExpiredError();
    }
    if (decision === "reject") {
      proposal.status = "rejected";
      this.persistProposal(frozen);
      return { proposal: clone(proposal) };
    }

    const terminal = this.terminals.get(proposal.terminalSessionId);
    if (terminal === undefined) {
      proposal.status = "stale";
      throw new ConversationTerminalNotFoundError();
    }
    try {
      assertFrozenScope(terminal.context(), frozen.scope);
      if (
        !terminal.context().environment.verified ||
        terminal.context().environment.bindingId === undefined
      ) {
        throw new Error("Terminal environment is not verified; automatic submission is disabled");
      }
      if (decision === "insert") {
        terminal.insertCommand(proposal.command);
        proposal.status = "inserted";
        this.persistProposal(frozen);
        return { proposal: clone(proposal) };
      }

      const operationId = randomUUID();
      const request = {
        ...frozen.scope,
        operationId,
      };
      terminal.validateApproved(request);
      const now = this.now().toISOString();
      const reserved: OperationSnapshot = {
        schemaVersion: 2,
        id: operationId,
        proposalId: proposal.id,
        status: "accepted",
        command: proposal.command,
        createdAt: now,
        updatedAt: now,
      };
      proposal.operationId = operationId;
      proposal.status = "accepted";
      this.persistence?.reserveOperation(proposal, frozen.scope, reserved);
      this.operations.set(operationId, reserved);
      const operation = terminal.submitApproved(request);
      const snapshot = toOperationSnapshot(proposal.id, operation);
      this.operations.set(operationId, snapshot);
      this.persistence?.saveOperation(snapshot);
      this.persistConversation(proposal.conversationId);
      return {
        proposal: clone(proposal),
        operation: clone(snapshot),
      };
    } catch (error) {
      if (proposal.operationId === undefined) {
        proposal.status = "stale";
        this.persistProposal(frozen);
      } else {
        const reserved = this.operations.get(proposal.operationId);
        if (reserved !== undefined) {
          reserved.status = "unknown";
          reserved.updatedAt = this.now().toISOString();
          this.persistence?.saveOperation(reserved);
        }
        this.persistConversation(proposal.conversationId);
      }
      throw error;
    }
  }

  operation(id: string): OperationSnapshot | undefined {
    const stored = this.operations.get(id);
    if (stored === undefined) return undefined;
    const frozen = this.proposals.get(stored.proposalId);
    const live = frozen === undefined
      ? undefined
      : this.terminals.get(frozen.proposal.terminalSessionId)?.operation(id);
    if (live === undefined) return clone(stored);
    const snapshot = toOperationSnapshot(stored.proposalId, live);
    this.operations.set(id, snapshot);
    this.persistence?.saveOperation(snapshot);
    return clone(snapshot);
  }

  async stop(id: string): Promise<void> {
    const conversation = this.requireConversation(id);
    const engine = this.requireEngine(conversation.snapshot.providerId);
    if (engine.stopTurn === undefined) return;
    await engine.stopTurn({
      conversationId: conversation.snapshot.id,
      ...(conversation.snapshot.providerSessionId === undefined
        ? {}
        : { providerSessionId: conversation.snapshot.providerSessionId }),
    });
  }

  private requireEngine(providerId: AiProviderId): AgentEngine {
    const engine = "engine" in this.engines
      ? this.engines.engine(providerId)
      : providerId === "chatgpt" ? this.engines : undefined;
    if (engine === undefined) throw new AgentEngineUnavailableError(providerId);
    return engine;
  }

  private requireConversation(id: string): ManagedConversation {
    const conversation = this.conversations.get(id);
    if (conversation === undefined) throw new ConversationNotFoundError();
    return conversation;
  }

  private requireProposal(id: string): FrozenProposal {
    const proposal = this.proposals.get(id);
    if (proposal === undefined) throw new ProposalNotFoundError();
    return proposal;
  }

  private persistProposal(frozen: FrozenProposal): void {
    this.persistence?.saveProposal(frozen.proposal, frozen.scope);
    const conversation = this.conversations.get(frozen.proposal.conversationId);
    if (conversation !== undefined) {
      this.persistence?.saveConversation(conversation.snapshot);
    }
  }

  private persistConversation(id: string): void {
    const conversation = this.conversations.get(id);
    if (conversation !== undefined) {
      this.persistence?.saveConversation(conversation.snapshot);
    }
  }
}

export function buildAssistantContext(
  context: TerminalContext,
  allCommands: ReturnType<import("./terminal-session.js").TerminalSession["commands"]>,
  requestedCommandIds: string[] | undefined,
  mode?: "auto" | "manual" | "none",
): AgentEngineContext {
  const requested = new Set(mode === "auto" || mode === "none" ? [] : requestedCommandIds ?? []);
  const recent = allCommands.slice(-20);
  const selected = [
    ...(mode === "manual" ? [] : recent),
    ...allCommands.filter((command) => requested.has(command.id)),
  ].filter((command, index, commands) =>
    commands.findIndex((candidate) => candidate.id === command.id) === index,
  );
  let remaining = maximumContextBytes;
  let contextTruncated = false;
  const includeOutput = new Set((mode === "manual" ? [] : recent.slice(-3)).map((command) => command.id));
  const mapped = selected.map((command) => {
    let output: string | undefined;
    if (includeOutput.has(command.id) || requested.has(command.id)) {
      const sanitized = sanitizeTerminalText(command.output);
      const bytes = Buffer.byteLength(sanitized, "utf8");
      if (bytes <= remaining) {
        output = sanitized;
        remaining -= bytes;
      } else {
        output = trimUtf8End(sanitized, Math.max(0, remaining));
        remaining = 0;
        contextTruncated = true;
      }
    }
    return {
      id: command.id,
      environmentFrameId: command.environmentFrameId,
      source: command.source,
      command: sanitizeTerminalText(command.command),
      cwd: command.cwdBefore,
      ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
      ...(output === undefined ? {} : { output }),
      outputTruncated: command.outputTruncated ||
        (output !== undefined && output !== sanitizeTerminalText(command.output)),
      captureQuality: command.captureQuality,
    };
  });
  return {
    terminalSessionId: context.terminalSessionId,
    environment: context.environment,
    environmentStack: context.environmentStack,
    cwd: context.cwd,
    shell: context.shell,
    user: context.user,
    shellState: context.shellState,
    recentCommands: mapped,
    contextTruncated,
  };
}

export class AgentEngineUnavailableError extends Error {
  constructor(readonly providerId: AiProviderId) {
    super(`${providerId} provider is unavailable`);
  }
}

/** @deprecated Use AgentEngine. */
export type TerminalAssistant = AgentEngine;
/** @deprecated Use AgentEngineContext. */
export type TerminalAssistantContext = AgentEngineContext;

function assertFrozenScope(
  context: TerminalContext,
  scope: ApprovedCommandRequest,
): void {
  if (
    context.terminalSessionId !== scope.terminalSessionId ||
    context.environment.id !== scope.environmentFrameId ||
    context.environment.bindingId !== scope.bindingId ||
    context.cwd !== scope.cwd ||
    context.shell !== scope.shell ||
    context.contextVersion !== scope.contextVersion ||
    context.inputVersion !== scope.inputVersion
  ) throw new Error("Terminal context changed; confirm the command again");
}

function toOperationSnapshot(
  proposalId: string,
  operation: ExecutionOperation,
): OperationSnapshot {
  return {
    schemaVersion: 2,
    id: operation.id,
    proposalId,
    status: operation.status,
    command: operation.command,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.commandBlockId === undefined
      ? {}
      : { commandBlockId: operation.commandBlockId }),
    ...(operation.exitCode === undefined ? {} : { exitCode: operation.exitCode }),
  };
}

function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PRIVATE BLOCK]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED TOKEN]");
}

function trimUtf8End(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class ConversationNotFoundError extends Error {}
export class ConversationTerminalNotFoundError extends Error {}
export class ProposalNotFoundError extends Error {}
export class ProposalExpiredError extends Error {}
