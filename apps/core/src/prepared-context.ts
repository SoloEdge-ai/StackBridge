import { randomUUID } from "node:crypto";
import type { AssistantContextPreview, ContextSelection, ContextSnapshot, ConversationMessage, TerminalAttachment } from "@stackbridge/protocol";
import type { AgentEngineContext } from "./conversation-service.js";
import type { TerminalSession } from "./terminal-session.js";

const limit = 64 * 1024;
export class PreparedContextError extends Error {}
interface PreparedContext {
  owner: string; terminalId: string; conversationId: string | undefined; expires: number;
  snapshot: ContextSnapshot; context: AgentEngineContext | null;
}

/** Owns immutable, browser-bound previews. Successful message snapshots are the delivery ledger. */
export class PreparedContexts {
  private readonly records = new Map<string, PreparedContext>();
  constructor(private readonly now: () => Date) {}

  prepare(terminal: TerminalSession, selection: ContextSelection, history: ConversationMessage[], owner: string): AssistantContextPreview {
    for (const [id, record] of this.records) if (record.expires <= this.now().getTime()) this.records.delete(id);
    // Bound memory for abandoned previews while allowing several panes and browsers.
    while (this.records.size >= 256) this.records.delete(this.records.keys().next().value!);
    const mode = selection.contextMode ?? "auto";
    const commands = terminal.commands();
    const environment = terminal.context();
    const sent = history.flatMap((message) => message.contextSnapshot?.status === "succeeded" ? message.contextSnapshot.attachments : []);
    const candidates = mode === "none" ? [] : mode === "manual"
      ? commands.filter((command) => selection.commandIds?.includes(command.id)) : commands.slice(-3);
    const attachments: TerminalAttachment[] = [];
    const context: AgentEngineContext | null = mode === "none" ? null : {
      terminalSessionId: terminal.id, environment: environment.environment, environmentStack: environment.environmentStack,
      cwd: environment.cwd, shell: environment.shell, user: environment.user, shellState: environment.shellState,
      recentCommands: [], contextTruncated: false,
    };
    for (const command of candidates.slice().reverse()) {
      const previous = sent.filter((item) => item.terminalSessionId === terminal.id && item.commandId === command.id);
      const retainedStart = command.outputEndSequence - Buffer.byteLength(command.output, "utf8");
      const deliveredEnd = Math.max(command.outputStartSequence, ...previous.map((item) => item.end));
      const remaining = unsentRanges(retainedStart, command.outputEndSequence, previous);
      if (mode === "auto" && previous.length && !remaining.length) continue;
      const range = mode === "manual" ? { start: retainedStart, end: command.outputEndSequence }
        : remaining.at(-1) ?? { start: retainedStart, end: command.outputEndSequence };
      let start = range.start;
      const end = range.end;
      const raw = Buffer.from(command.output, "utf8");
      const attachment: TerminalAttachment = {
        commandId: command.id, terminalSessionId: terminal.id,
        environmentLabel: command.environmentLabel ?? command.environmentFrameId,
        cwd: command.cwdBefore, command: sanitizeTerminalText(command.command),
        output: sanitizeTerminalText(raw.subarray(start - retainedStart, end - retainedStart).toString("utf8")), start, end,
        commandStart: command.commandStartSequence ?? command.outputStartSequence,
        outputStart: command.outputStartSequence, repeated: mode === "manual" && previous.length > 0,
        truncated: command.outputTruncated, gap: retainedStart > deliveredEnd,
        includeCommand: mode === "manual" || previous.length === 0,
      };
      const mapped = {
        id: command.id, environmentFrameId: command.environmentFrameId, source: command.source,
        command: attachment.command, cwd: command.cwdBefore,
        ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
        output: attachment.output, outputTruncated: attachment.truncated, captureQuality: command.captureQuality,
      };
      context!.recentCommands.unshift(mapped);
      // Trim from the oldest side on UTF-8 boundaries, measuring the actual JSON envelope.
      while (Buffer.byteLength(JSON.stringify(context), "utf8") > limit && start < end) {
        const excess = Buffer.byteLength(JSON.stringify(context), "utf8") - limit;
        start = Math.min(end, start + Math.max(256, excess));
        while (start < end && (raw[start - retainedStart]! & 0xc0) === 0x80) start++;
        attachment.start = start;
        attachment.output = sanitizeTerminalText(raw.subarray(start - retainedStart, end - retainedStart).toString("utf8"));
        attachment.truncated = true;
        mapped.output = attachment.output;
        mapped.outputTruncated = true;
        context!.contextTruncated = true;
      }
      if (Buffer.byteLength(JSON.stringify(context), "utf8") > limit) {
        context!.recentCommands.shift();
        context!.contextTruncated = true;
        continue;
      }
      attachments.unshift(attachment);
    }
    if (context && Buffer.byteLength(JSON.stringify(context), "utf8") > limit) throw new PreparedContextError("context_metadata_too_large");
    const snapshot: ContextSnapshot = { mode, status: "pending", contextJson: context === null ? null : JSON.stringify(context), attachments, truncated: context?.contextTruncated === true || attachments.some((item) => item.truncated || item.gap) };
    const id = randomUUID();
    const expires = this.now().getTime() + 10 * 60_000;
    this.records.set(id, { owner, terminalId: terminal.id, conversationId: selection.conversationId, expires, snapshot, context });
    return {
      preparedId: id, expiresAt: new Date(expires).toISOString(), attachments: structuredClone(attachments), truncated: snapshot.truncated,
      bytes: snapshot.contextJson === null ? 0 : Buffer.byteLength(snapshot.contextJson, "utf8"), outputCount: attachments.length,
      commands: commands.slice(-20).map((command) => ({ id: command.id, command: sanitizeTerminalText(command.command), cwd: command.cwdBefore, ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }), output: sanitizeTerminalText(command.output).slice(-4000), commandStart: command.commandStartSequence ?? command.outputStartSequence, outputStart: command.outputStartSequence, outputEnd: command.outputEndSequence })),
    };
  }

  bind(id: string, owner: string, terminalId: string, conversationId: string): void {
    const record = this.get(id, owner, terminalId);
    if (record.conversationId !== undefined) throw new PreparedContextError("context_preparation_mismatch");
    record.conversationId = conversationId;
  }

  get(id: string, owner: string, terminalId: string): PreparedContext {
    const record = this.records.get(id);
    if (!record || record.expires <= this.now().getTime()) throw new PreparedContextError("context_preparation_expired");
    if (record.owner !== owner || record.terminalId !== terminalId) throw new PreparedContextError("context_preparation_mismatch");
    return record;
  }

  consume(id: string, owner: string, terminalId: string, conversationId: string): PreparedContext {
    const record = this.get(id, owner, terminalId);
    if (record.conversationId !== conversationId) throw new PreparedContextError("context_preparation_mismatch");
    this.records.delete(id);
    return structuredClone(record);
  }
}

export function sanitizeTerminalText(value: string): string {
  return value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PRIVATE BLOCK]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED TOKEN]");
}

function unsentRanges(start: number, end: number, sent: TerminalAttachment[]): Array<{ start: number; end: number }> {
  let ranges = start < end ? [{ start, end }] : [];
  for (const delivered of sent) {
    ranges = ranges.flatMap((range) => {
      if (delivered.end <= range.start || delivered.start >= range.end) return [range];
      return [...(delivered.start > range.start ? [{ start: range.start, end: delivered.start }] : []),
        ...(delivered.end < range.end ? [{ start: delivered.end, end: range.end }] : [])];
    });
  }
  return ranges;
}
