import { z } from "zod";

const schemaVersion = z.literal(1);
const entityId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const displayName = z.string().trim().min(1).max(256);
const nonEmptyValue = z.string().trim().min(1).max(512);
const targetPath = z.string().min(1).max(4_096);
const savedEntityFields = {
  schemaVersion,
  id: entityId,
  displayName,
};

export const sshConnectionProfileSchema = z
  .object({
    ...savedEntityFields,
    kind: z.literal("ssh"),
    host: nonEmptyValue,
    port: z.number().int().min(1).max(65_535),
    user: nonEmptyValue,
    credentialRef: nonEmptyValue.optional(),
    proxyJumpProfileIds: z.array(entityId).max(8),
  })
  .strict();

export const dockerDaemonConnectionProfileSchema = z
  .object({
    ...savedEntityFields,
    kind: z.literal("docker-daemon"),
    contextName: nonEmptyValue,
  })
  .strict();

export const connectionProfileSchema = z.discriminatedUnion("kind", [
  sshConnectionProfileSchema,
  dockerDaemonConnectionProfileSchema,
]);

export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;

export const dockerExecutionTargetSchema = z
  .object({
    ...savedEntityFields,
    kind: z.literal("docker"),
    parentTargetId: entityId,
    daemonProfileId: entityId,
    containerSelector: nonEmptyValue,
    requestedUser: nonEmptyValue,
  })
  .strict();

export const localExecutionTargetSchema = z
  .object({
    ...savedEntityFields,
    kind: z.literal("local"),
    platform: z.enum(["windows", "linux"]),
  })
  .strict();

export const sshExecutionTargetSchema = z
  .object({
    ...savedEntityFields,
    kind: z.literal("ssh"),
    connectionProfileId: entityId,
  })
  .strict();

export const executionTargetSchema = z.discriminatedUnion("kind", [
  localExecutionTargetSchema,
  sshExecutionTargetSchema,
  dockerExecutionTargetSchema,
]);

export type ExecutionTarget = z.infer<typeof executionTargetSchema>;

export const runtimeCapabilitySchema = z.enum([
  "process.argv",
  "process.shell",
  "fs.read",
  "fs.write",
  "terminal.pty",
  "docker.discover",
]);

const principalSchema = z
  .object({
    uid: z.number().int().nonnegative().optional(),
    gid: z.number().int().nonnegative().optional(),
    name: z.string().trim().min(1).max(256).optional(),
  })
  .strict()
  .refine((principal) => principal.uid !== undefined || principal.name !== undefined, {
    message: "A verified principal needs a uid or name.",
  });

const runtimeBindingFields = {
  schemaVersion,
  bindingId: entityId,
  targetId: entityId,
  generation: nonEmptyValue,
  runtimeInstanceId: entityId,
  principal: principalSchema,
  arch: z.string().trim().min(1).max(64),
  workspaceRoots: z.array(targetPath).min(1).max(32),
  capabilities: z.array(runtimeCapabilitySchema).min(1).max(32),
};

export const dockerRuntimeBindingSchema = z
  .object({
    ...runtimeBindingFields,
    targetKind: z.literal("docker"),
    verifiedHostKey: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/),
    hostBootId: nonEmptyValue,
    dockerDaemonId: nonEmptyValue,
    containerId: z.string().regex(/^[0-9a-f]{64}$/),
    containerStartedAt: z.string().datetime({ offset: true }),
    platform: z.literal("linux"),
    mountsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export const localRuntimeBindingSchema = z
  .object({
    ...runtimeBindingFields,
    targetKind: z.literal("local"),
    platform: z.enum(["windows", "linux"]),
  })
  .strict();

export const sshRuntimeBindingSchema = z
  .object({
    ...runtimeBindingFields,
    targetKind: z.literal("ssh"),
    verifiedHostKey: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/),
    hostBootId: nonEmptyValue,
    platform: z.literal("linux"),
  })
  .strict();

export const runtimeBindingSchema = z.discriminatedUnion("targetKind", [
  localRuntimeBindingSchema,
  sshRuntimeBindingSchema,
  dockerRuntimeBindingSchema,
]);

export type RuntimeBinding = z.infer<typeof runtimeBindingSchema>;

export const argvExecutionCommandSchema = z
  .object({
    kind: z.literal("argv"),
    program: targetPath,
    args: z.array(z.string().max(65_536)).max(1_024),
  })
  .strict();

export const shellExecutionCommandSchema = z
  .object({
    kind: z.literal("shell"),
    shell: targetPath,
    script: z.string().min(1).max(1_048_576),
  })
  .strict();

export const executionCommandSchema = z.discriminatedUnion("kind", [
  argvExecutionCommandSchema,
  shellExecutionCommandSchema,
]);

export const executionRequestSchema = z
  .object({
    schemaVersion,
    requestId: entityId,
    operationId: entityId,
    agentSessionId: entityId,
    expectedBindingId: entityId,
    cwd: targetPath,
    command: executionCommandSchema,
    environmentProfileId: entityId,
    timeoutMs: z.number().int().min(1).max(86_400_000),
    approvalId: entityId,
  })
  .strict();

export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
