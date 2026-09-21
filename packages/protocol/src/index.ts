import { z } from "zod";

export * from "./targets.js";

const terminalDimensionSchema = z.number().int().min(2).max(1_000);

const terminalDimensions = {
  cols: terminalDimensionSchema,
  rows: terminalDimensionSchema,
};

const localTerminalSessionRequestSchema = z.object({
  ...terminalDimensions,
  kind: z.literal("local").optional(),
}).strict();

const sshTerminalSessionRequestSchema = z.object({
  ...terminalDimensions,
  kind: z.literal("ssh"),
  host: z.string().trim().min(1).max(512),
  port: z.number().int().min(1).max(65_535),
  user: z.string().trim().min(1).max(512),
  deploymentApprovalId: z.uuid().optional(),
}).strict();

const dockerTerminalSessionRequestSchema = z.object({
  ...terminalDimensions,
  kind: z.literal("docker"),
  host: z.string().trim().min(1).max(512),
  port: z.number().int().min(1).max(65_535),
  user: z.string().trim().min(1).max(512),
  contextName: z.string().trim().min(1).max(512),
  container: z.string().trim().min(1).max(512),
  containerUser: z.string().trim().min(1).max(512),
  cwd: z.string().startsWith("/").max(4_096),
  deploymentApprovalId: z.uuid().optional(),
}).strict();

export const createTerminalSessionRequestSchema = z.union([
  sshTerminalSessionRequestSchema,
  dockerTerminalSessionRequestSchema,
  localTerminalSessionRequestSchema,
]);

export type CreateTerminalSessionRequest = z.infer<
  typeof createTerminalSessionRequestSchema
>;

export const reusableTerminalSessionRequestSchema = z.union([
  sshTerminalSessionRequestSchema.omit({ deploymentApprovalId: true }),
  dockerTerminalSessionRequestSchema.omit({ deploymentApprovalId: true }),
  localTerminalSessionRequestSchema,
]);

export type ReusableTerminalSessionRequest = z.infer<
  typeof reusableTerminalSessionRequestSchema
>;

export const terminalSessionSnapshotSchema = z.object({
  id: z.uuid(),
  state: z.enum(["running", "exited"]),
  cols: terminalDimensionSchema,
  rows: terminalDimensionSchema,
  replay: z.string(),
  exitCode: z.number().int().optional(),
  signal: z.number().int().optional(),
});

export type TerminalSessionSnapshot = z.infer<
  typeof terminalSessionSnapshotSchema
>;

export const terminalEnvironmentSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).optional(),
  kind: z.enum(["local", "ssh", "docker"]),
  label: z.string(),
  verified: z.boolean(),
  bindingId: z.string().min(1).optional(),
  host: z.string().optional(),
  containerId: z.string().optional(),
}).strict();

export type TerminalEnvironment = z.infer<typeof terminalEnvironmentSchema>;

export const terminalContextSchema = z.object({
  terminalSessionId: z.uuid(),
  contextVersion: z.number().int().nonnegative(),
  shellState: z.enum(["idle", "running", "foreground", "unknown"]),
  inputVersion: z.number().int().nonnegative(),
  inputEmpty: z.boolean(),
  cwd: z.string(),
  shell: z.string(),
  user: z.string(),
  outputSequence: z.number().int().nonnegative(),
  environment: terminalEnvironmentSchema,
  environmentStack: z.array(terminalEnvironmentSchema),
  recentCommandIds: z.array(z.string()),
}).strict();

export type TerminalContext = z.infer<typeof terminalContextSchema>;

export const clientTerminalMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input"),
    data: z.string().max(65_536),
  }),
  z.object({
    type: z.literal("resize"),
    cols: terminalDimensionSchema,
    rows: terminalDimensionSchema,
  }),
  z.object({
    type: z.literal("acquireWriteLease"),
  }),
]);

export type ClientTerminalMessage = z.infer<typeof clientTerminalMessageSchema>;

export const serverTerminalMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    sessionId: z.uuid(),
    state: z.enum(["running", "exited"]),
    cols: terminalDimensionSchema,
    rows: terminalDimensionSchema,
    replay: z.string(),
    writable: z.boolean(),
  }),
  z.object({
    type: z.literal("output"),
    data: z.string(),
  }),
  z.object({
    type: z.literal("writable"),
    writable: z.boolean(),
  }),
  z.object({
    type: z.literal("exit"),
    exitCode: z.number().int(),
    signal: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);

export type ServerTerminalMessage = z.infer<typeof serverTerminalMessageSchema>;

const remoteText = z.string().trim().min(1).max(512);
const schemaVersion2 = z.literal(2).default(2);

export const createRemoteSessionRequestSchema = z.object({
  host: remoteText,
  port: z.number().int().min(1).max(65_535),
  user: remoteText,
  deploymentApprovalId: z.uuid().optional(),
  docker: z.object({
    contextName: remoteText,
    selector: remoteText,
    requestedUser: remoteText,
    cwd: z.string().startsWith("/").max(4_096),
  }).strict().optional(),
}).strict();

export type CreateRemoteSessionRequest = z.infer<typeof createRemoteSessionRequestSchema>;

export const deploymentProposalSchema = z.object({
  reason: z.enum(["missing", "upgrade", "repair"]),
  installRoot: z.literal("~/.sbridge"),
  runtimeVersion: remoteText,
  runtimeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  platform: z.literal("linux"),
  arch: z.enum(["amd64", "arm64"]),
  user: remoteText,
  host: remoteText,
  hostKeyFingerprint: remoteText,
  permissions: z.literal("0700 directories, 0755 runtime"),
  cleanup: z.literal("Disconnect StackBridge, then remove ~/.sbridge"),
}).strict();

export type DeploymentProposal = z.infer<typeof deploymentProposalSchema>;

export const remoteSessionSnapshotSchema = z.object({
  schemaVersion: schemaVersion2,
  sessionId: z.uuid(),
  bindingId: z.uuid(),
  targetKind: z.enum(["ssh", "docker"]),
  host: remoteText,
  user: remoteText,
  hostKeyFingerprint: remoteText,
  runtimeVersion: remoteText,
  runtimeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  runtimeInstanceId: remoteText,
  hostBootId: remoteText,
  arch: remoteText,
  defaultCwd: z.string().startsWith("/"),
  shell: z.string().startsWith("/").nullable(),
  deployment: z.enum(["reused", "installed", "upgraded"]),
  containerId: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

export type RemoteSessionSnapshot = z.infer<typeof remoteSessionSnapshotSchema>;

export const remoteExecutionRequestSchema = z.object({
  cwd: z.string().startsWith("/").max(4_096),
  program: z.string().startsWith("/").max(4_096),
  args: z.array(z.string().max(65_536)).max(1_024),
  timeoutMs: z.number().int().min(1).max(86_400_000),
}).strict();

export type RemoteExecutionRequest = z.infer<typeof remoteExecutionRequestSchema>;

export const remoteExecutionResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  stdoutTruncated: z.boolean().optional(),
  stderrTruncated: z.boolean().optional(),
}).strict();

export type RemoteExecutionResult = z.infer<typeof remoteExecutionResultSchema>;

export const createConversationRequestSchema = z.object({
  schemaVersion: schemaVersion2,
  terminalSessionId: z.uuid(),
  providerId: z.enum(["chatgpt", "deepseek"]).optional(),
  model: z.string().trim().min(1).max(128).optional(),
}).strict();

export type CreateConversationRequest = z.infer<
  typeof createConversationRequestSchema
>;

export const createTurnRequestSchema = z.object({
  schemaVersion: schemaVersion2,
  terminalSessionId: z.uuid(),
  message: z.string().trim().min(1).max(32_768),
  commandIds: z.array(z.uuid()).max(20).optional(),
}).strict();

export type CreateTurnRequest = z.infer<typeof createTurnRequestSchema>;

export const approvalDecisionRequestSchema = z.object({
  schemaVersion: schemaVersion2,
  decision: z.enum(["execute", "insert", "reject"]),
}).strict();

export type ApprovalDecisionRequest = z.infer<
  typeof approvalDecisionRequestSchema
>;

export const aiAccountStatusSchema = z.object({
  schemaVersion: schemaVersion2,
  available: z.boolean(),
  authenticated: z.boolean(),
  accountLabel: z.string().optional(),
  loginType: z.string().optional(),
  error: z.string().optional(),
}).strict();

export type AiAccountStatus = z.infer<typeof aiAccountStatusSchema>;

export const aiProviderIdSchema = z.enum(["chatgpt", "deepseek"]);
export type AiProviderId = z.infer<typeof aiProviderIdSchema>;

export const aiModelSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  isDefault: z.boolean(),
}).strict();
export type AiModel = z.infer<typeof aiModelSchema>;

export const aiProviderSummarySchema = z.object({
  id: aiProviderIdSchema,
  kind: aiProviderIdSchema,
  label: z.string().min(1),
  available: z.boolean(),
  configured: z.boolean(),
  authenticated: z.boolean(),
  credentialPersistence: z.enum(["codex-managed", "system-encrypted", "session-only"]),
  hasApiKey: z.boolean().optional(),
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).optional(),
  lastVerifiedAt: z.string().datetime({ offset: true }).optional(),
  accountLabel: z.string().optional(),
  error: z.string().optional(),
}).strict();
export type AiProviderSummary = z.infer<typeof aiProviderSummarySchema>;

export const deepSeekProviderInputSchema = z.object({
  schemaVersion: schemaVersion2,
  baseUrl: z.string().trim().min(1).max(2_048),
  model: z.string().trim().min(1).max(128),
  apiKey: z.string().trim().min(1).max(4_096).optional(),
}).strict();
export type DeepSeekProviderInput = z.infer<typeof deepSeekProviderInputSchema>;

export const commandProposalSchema = z.object({
  schemaVersion: schemaVersion2,
  id: z.uuid(),
  conversationId: z.uuid(),
  agentSessionId: z.uuid(),
  terminalSessionId: z.uuid(),
  environmentFrameId: z.string().min(1),
  environmentKind: z.enum(["local", "ssh", "docker"]).default("local"),
  environmentLabel: z.string().min(1).default("当前环境"),
  host: z.string().min(1).optional(),
  containerId: z.string().min(1).optional(),
  bindingId: z.string().min(1).optional(),
  purpose: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string(),
  shell: z.string(),
  user: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  status: z.enum([
    "pending",
    "inserted",
    "rejected",
    "accepted",
    "expired",
    "stale",
  ]),
  operationId: z.uuid().optional(),
}).strict();

export type CommandProposal = z.infer<typeof commandProposalSchema>;

export const conversationMessageSchema = z.object({
  schemaVersion: schemaVersion2,
  id: z.uuid(),
  role: z.enum(["user", "assistant", "timeline"]),
  content: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  agentSessionId: z.uuid().optional(),
  proposalIds: z.array(z.uuid()).optional(),
}).strict();

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const conversationSnapshotSchema = z.object({
  schemaVersion: schemaVersion2,
  id: z.uuid(),
  title: z.string(),
  providerId: aiProviderIdSchema.default("chatgpt"),
  model: z.string(),
  providerSessionId: z.string().optional(),
  codexThreadId: z.string().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  messages: z.array(conversationMessageSchema),
  proposals: z.array(commandProposalSchema),
}).strict();

export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;

export const operationSnapshotSchema = z.object({
  schemaVersion: schemaVersion2,
  id: z.uuid(),
  proposalId: z.uuid(),
  status: z.enum([
    "accepted",
    "running",
    "completed",
    "failed",
    "interrupted",
    "unknown",
  ]),
  command: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  commandBlockId: z.uuid().optional(),
  exitCode: z.number().int().optional(),
}).strict();

export type OperationSnapshot = z.infer<typeof operationSnapshotSchema>;
