import { z } from "zod";

export * from "./targets.js";

const terminalDimensionSchema = z.number().int().min(2).max(1_000);

export const createTerminalSessionRequestSchema = z.object({
  cols: terminalDimensionSchema,
  rows: terminalDimensionSchema,
});

export type CreateTerminalSessionRequest = z.infer<
  typeof createTerminalSessionRequestSchema
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
  sessionId: z.uuid(),
  targetKind: z.enum(["ssh", "docker"]),
  host: remoteText,
  user: remoteText,
  hostKeyFingerprint: remoteText,
  runtimeVersion: remoteText,
  runtimeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
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
