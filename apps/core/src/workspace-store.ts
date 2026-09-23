import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import {
  commandProposalSchema,
  conversationSnapshotSchema,
  operationSnapshotSchema,
  type CommandProposal,
  type ConversationSnapshot,
  type OperationSnapshot,
} from "@stackbridge/protocol";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

import type { ApprovedCommandRequest, CommandBlock } from "./terminal-session.js";

const schemaVersion = 4;
const defaultRetentionMs = 7 * 24 * 60 * 60_000;
const defaultOutputLimitBytes = 1024 * 1024 * 1024;

export interface StoredFrozenProposal {
  proposal: CommandProposal;
  scope: ApprovedCommandRequest;
}

export interface ConversationPersistence {
  loadConversations(): ConversationSnapshot[];
  loadProposals(): StoredFrozenProposal[];
  loadOperations(): OperationSnapshot[];
  saveConversation(snapshot: ConversationSnapshot): void;
  saveProposal(proposal: CommandProposal, scope: ApprovedCommandRequest): void;
  saveOperation(operation: OperationSnapshot): void;
  replaceProposal(original: StoredFrozenProposal, replacement: StoredFrozenProposal, conversation: ConversationSnapshot): void;
  reserveOperation(
    proposal: CommandProposal,
    scope: ApprovedCommandRequest,
    operation: OperationSnapshot,
  ): void;
}

export interface StoredDeepSeekProfile {
  baseUrl: string;
  model: string;
  protectedApiKey: string;
  updatedAt: string;
  lastVerifiedAt?: string;
}

export interface AiProviderProfilePersistence {
  loadDeepSeekProfile(): StoredDeepSeekProfile | undefined;
  saveDeepSeekProfile(profile: StoredDeepSeekProfile): void;
  deleteDeepSeekProfile(): void;
}

export class WorkspaceStore implements ConversationPersistence {
  private readonly database: DatabaseSyncType;
  private readonly outputDirectory: string;
  private readonly settingsPath: string;

  constructor(
    dataDirectory: string,
    private readonly options: {
      now?: () => Date;
      retentionMs?: number;
      outputLimitBytes?: number;
    } = {},
  ) {
    mkdirSync(dataDirectory, { recursive: true });
    this.outputDirectory = join(dataDirectory, "terminal-output");
    this.settingsPath = join(dataDirectory, "settings.json");
    mkdirSync(this.outputDirectory, { recursive: true });
    const databasePath = join(dataDirectory, "stackbridge.sqlite");
    if (existsSync(databasePath)) this.backupBeforeMigration(databasePath);
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  loadConversations(): ConversationSnapshot[] {
    const rows = this.database.prepare(
      "SELECT snapshot_json FROM conversations ORDER BY updated_at DESC",
    ).all() as Array<{ snapshot_json: string }>;
    return rows.flatMap(({ snapshot_json }) => {
      const parsed = conversationSnapshotSchema.safeParse(JSON.parse(snapshot_json));
      if (!parsed.success) return [];
      const providerSessionId = parsed.data.providerSessionId ?? parsed.data.codexThreadId;
      const { codexThreadId: _legacyCodexThreadId, ...snapshot } = parsed.data;
      return [{
        ...snapshot,
        ...(providerSessionId === undefined ? {} : { providerSessionId }),
      }];
    });
  }

  loadProposals(): StoredFrozenProposal[] {
    const rows = this.database.prepare(
      "SELECT proposal_json, scope_json FROM frozen_proposals",
    ).all() as Array<{ proposal_json: string; scope_json: string }>;
    return rows.flatMap(({ proposal_json, scope_json }) => {
      const parsed = commandProposalSchema.safeParse(JSON.parse(proposal_json));
      if (!parsed.success) return [];
      const scope = parseApprovedScope(JSON.parse(scope_json));
      return scope === undefined ? [] : [{ proposal: parsed.data, scope }];
    });
  }

  loadOperations(): OperationSnapshot[] {
    const rows = this.database.prepare(
      "SELECT snapshot_json FROM execution_operations ORDER BY created_at ASC",
    ).all() as Array<{ snapshot_json: string }>;
    return rows.flatMap(({ snapshot_json }) => {
      const parsed = operationSnapshotSchema.safeParse(JSON.parse(snapshot_json));
      return parsed.success ? [parsed.data] : [];
    });
  }

  loadLocale(): "en" | "zh-CN" {
    return this.readSettings().locale === "zh-CN" ? "zh-CN" : "en";
  }

  loadDeepSeekProfile(): StoredDeepSeekProfile | undefined {
    const row = this.database.prepare(
      "SELECT profile_json FROM ai_provider_profiles WHERE id = 'deepseek'",
    ).get() as { profile_json: string } | undefined;
    if (row === undefined) return undefined;
    const value = JSON.parse(row.profile_json) as Partial<StoredDeepSeekProfile>;
    if (
      typeof value.baseUrl !== "string" ||
      typeof value.model !== "string" ||
      typeof value.protectedApiKey !== "string" ||
      typeof value.updatedAt !== "string"
    ) return undefined;
    return {
      baseUrl: value.baseUrl,
      model: value.model,
      protectedApiKey: value.protectedApiKey,
      updatedAt: value.updatedAt,
      ...(typeof value.lastVerifiedAt === "string"
        ? { lastVerifiedAt: value.lastVerifiedAt }
        : {}),
    };
  }

  saveDeepSeekProfile(profile: StoredDeepSeekProfile): void {
    this.database.prepare(`
      INSERT INTO ai_provider_profiles (id, profile_json, updated_at)
      VALUES ('deepseek', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        profile_json = excluded.profile_json,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(profile), profile.updatedAt);
  }

  deleteDeepSeekProfile(): void {
    this.database.prepare("DELETE FROM ai_provider_profiles WHERE id = 'deepseek'").run();
  }

  saveLocale(locale: "en" | "zh-CN"): void {
    this.writeSettings({ ...this.readSettings(), locale });
  }

  loadAiProviderId(): "chatgpt" | "deepseek" {
    return this.readSettings().aiProviderId === "deepseek" ? "deepseek" : "chatgpt";
  }

  saveAiProviderId(aiProviderId: "chatgpt" | "deepseek"): void {
    this.writeSettings({ ...this.readSettings(), aiProviderId });
  }

  private readSettings(): { locale?: unknown; aiProviderId?: unknown } {
    try {
      return JSON.parse(readFileSync(this.settingsPath, "utf8")) as {
        locale?: unknown;
        aiProviderId?: unknown;
      };
    } catch {
      return {};
    }
  }

  private writeSettings(value: { locale?: unknown; aiProviderId?: unknown }): void {
    const temporaryPath = `${this.settingsPath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, this.settingsPath);
  }

  saveConversation(snapshot: ConversationSnapshot): void {
    this.database.prepare(`
      INSERT INTO conversations (id, created_at, updated_at, snapshot_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        snapshot_json = excluded.snapshot_json
    `).run(snapshot.id, snapshot.createdAt, snapshot.updatedAt, JSON.stringify(snapshot));
  }

  saveProposal(proposal: CommandProposal, scope: ApprovedCommandRequest): void {
    this.database.prepare(`
      INSERT INTO frozen_proposals (id, conversation_id, proposal_json, scope_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        proposal_json = excluded.proposal_json,
        scope_json = excluded.scope_json
    `).run(proposal.id, proposal.conversationId, JSON.stringify(proposal), JSON.stringify(scope));
  }

  saveOperation(operation: OperationSnapshot): void {
    this.database.prepare(`
      INSERT INTO execution_operations (id, proposal_id, created_at, updated_at, snapshot_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        snapshot_json = excluded.snapshot_json
    `).run(
      operation.id,
      operation.proposalId,
      operation.createdAt,
      operation.updatedAt,
      JSON.stringify(operation),
    );
  }

  reserveOperation(
    proposal: CommandProposal,
    scope: ApprovedCommandRequest,
    operation: OperationSnapshot,
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.saveProposal(proposal, scope);
      this.saveOperation(operation);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  replaceProposal(original: StoredFrozenProposal, replacement: StoredFrozenProposal, conversation: ConversationSnapshot): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.saveProposal(original.proposal, original.scope);
      this.saveProposal(replacement.proposal, replacement.scope);
      this.saveConversation(conversation);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordCommand(command: CommandBlock): void {
    const directory = join(this.outputDirectory, command.terminalSessionId);
    mkdirSync(directory, { recursive: true });
    const outputPath = join(directory, `${command.id}.log`);
    const temporaryPath = `${outputPath}.tmp`;
    writeFileSync(temporaryPath, command.output, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, outputPath);
    const metadata = { ...command, output: "" };
    this.database.prepare(`
      INSERT INTO command_blocks (
        id, terminal_session_id, environment_frame_id, ended_at,
        metadata_json, output_path, output_cleaned
      ) VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        metadata_json = excluded.metadata_json,
        output_path = excluded.output_path,
        output_cleaned = 0
    `).run(
      command.id,
      command.terminalSessionId,
      command.environmentFrameId,
      command.endedAt,
      JSON.stringify(metadata),
      outputPath,
    );
    this.pruneOutputs();
  }

  readCommand(id: string): CommandBlock | undefined {
    const row = this.database.prepare(
      "SELECT metadata_json, output_path, output_cleaned FROM command_blocks WHERE id = ?",
    ).get(id) as { metadata_json: string; output_path: string | null; output_cleaned: number } | undefined;
    if (row === undefined) return undefined;
    const metadata = JSON.parse(row.metadata_json) as CommandBlock;
    const output = row.output_path !== null && existsSync(row.output_path)
      ? readFileSync(row.output_path, "utf8")
      : "";
    return {
      ...metadata,
      output,
      outputTruncated: metadata.outputTruncated || row.output_cleaned === 1,
    };
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const current = this.database.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    ).get() as { version: number };
    if (current.version > schemaVersion) {
      throw new Error(`StackBridge database schema ${current.version} is newer than supported schema ${schemaVersion}`);
    }
    if (current.version < 1) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL
        );
        CREATE TABLE frozen_proposals (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          proposal_json TEXT NOT NULL,
          scope_json TEXT NOT NULL,
          FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE TABLE command_blocks (
          id TEXT PRIMARY KEY,
          terminal_session_id TEXT NOT NULL,
          environment_frame_id TEXT NOT NULL,
          ended_at TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          output_path TEXT,
          output_cleaned INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX command_blocks_terminal_time
          ON command_blocks(terminal_session_id, ended_at DESC);
        INSERT INTO schema_migrations (version, applied_at)
          VALUES (1, datetime('now'));
        COMMIT;
      `);
    }
    if (current.version < 2) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE execution_operations (
          id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          FOREIGN KEY(proposal_id) REFERENCES frozen_proposals(id) ON DELETE CASCADE
        );
        CREATE INDEX execution_operations_proposal
          ON execution_operations(proposal_id, updated_at DESC);
        INSERT INTO schema_migrations (version, applied_at)
          VALUES (2, datetime('now'));
        COMMIT;
      `);
    }
    if (current.version < 3) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE ai_provider_profiles (
          id TEXT PRIMARY KEY,
          profile_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations (version, applied_at)
          VALUES (3, datetime('now'));
        COMMIT;
      `);
    }
    if (current.version < 4) {
      // Message attachment snapshots and delivery state live inside snapshot_json.
      this.database.exec("INSERT INTO schema_migrations (version, applied_at) VALUES (4, datetime('now'))");
    }
  }

  private backupBeforeMigration(databasePath: string): void {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      ).get();
      if (row === undefined) return;
      const current = database.prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      ).get() as { version: number };
      if (current.version >= schemaVersion) return;
    } finally {
      database.close();
    }
    const suffix = (this.options.now?.() ?? new Date()).toISOString().replaceAll(/[:.]/g, "-");
    copyFileSync(databasePath, `${databasePath}.backup-${suffix}`);
  }

  private pruneOutputs(): void {
    const now = this.options.now?.() ?? new Date();
    const cutoff = new Date(now.getTime() - (this.options.retentionMs ?? defaultRetentionMs)).toISOString();
    const expired = this.database.prepare(`
      SELECT id, output_path FROM command_blocks
      WHERE output_path IS NOT NULL AND ended_at < ?
      ORDER BY ended_at ASC
    `).all(cutoff) as Array<{ id: string; output_path: string }>;
    for (const row of expired) this.cleanOutput(row.id, row.output_path);

    const retained = this.database.prepare(`
      SELECT id, output_path FROM command_blocks
      WHERE output_path IS NOT NULL
      ORDER BY ended_at DESC
    `).all() as Array<{ id: string; output_path: string }>;
    const limit = this.options.outputLimitBytes ?? defaultOutputLimitBytes;
    let total = 0;
    for (const row of retained) {
      let size = 0;
      try {
        size = statSync(row.output_path).size;
      } catch {}
      total += size;
      if (total > limit) this.cleanOutput(row.id, row.output_path);
    }
  }

  private cleanOutput(id: string, outputPath: string): void {
    try {
      unlinkSync(outputPath);
    } catch {}
    this.database.prepare(
      "UPDATE command_blocks SET output_path = NULL, output_cleaned = 1 WHERE id = ?",
    ).run(id);
  }
}

function parseApprovedScope(value: unknown): ApprovedCommandRequest | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.operationId !== "string" ||
    typeof record.command !== "string" ||
    typeof record.terminalSessionId !== "string" ||
    typeof record.environmentFrameId !== "string" ||
    !(record.bindingId === undefined || typeof record.bindingId === "string") ||
    typeof record.cwd !== "string" ||
    typeof record.shell !== "string" ||
    !Number.isInteger(record.contextVersion) ||
    !Number.isInteger(record.inputVersion)
  ) return undefined;
  return value as ApprovedCommandRequest;
}
