import { z } from "zod";

const schemaVersion = z.literal(1);
const opaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const displayName = z.string().trim().min(1).max(256);
const nonEmptyValue = z.string().trim().min(1).max(512);
const targetPath = z.string().min(1).max(4_096).brand<"TargetPath">();
const sshHost = nonEmptyValue.brand<"SshHost">();
const credentialReference = nonEmptyValue.brand<"CredentialReference">();
const containerSelector = nonEmptyValue.brand<"ContainerSelector">();
const bindingGeneration = nonEmptyValue.brand<"BindingGeneration">();

export const connectionProfileIdSchema = opaqueId.brand<"ConnectionProfileId">();
export const executionTargetIdSchema = opaqueId.brand<"ExecutionTargetId">();
export const runtimeBindingIdSchema = opaqueId.brand<"RuntimeBindingId">();
export const runtimeInstanceIdSchema = opaqueId.brand<"RuntimeInstanceId">();
export const executionRequestIdSchema = opaqueId.brand<"ExecutionRequestId">();
export const operationIdSchema = opaqueId.brand<"OperationId">();
export const agentSessionIdSchema = opaqueId.brand<"AgentSessionId">();
export const environmentProfileIdSchema = opaqueId.brand<"EnvironmentProfileId">();
export const approvalIdSchema = opaqueId.brand<"ApprovalId">();

const savedEntityFields = {
  schemaVersion,
  displayName,
};

export const sshConnectionProfileSchema = z
  .object({
    ...savedEntityFields,
    id: connectionProfileIdSchema,
    kind: z.literal("ssh"),
    host: sshHost,
    port: z.number().int().min(1).max(65_535),
    user: nonEmptyValue,
    credentialRef: credentialReference.optional(),
    proxyJumpProfileIds: z.array(connectionProfileIdSchema).max(8),
  })
  .strict();

export const dockerDaemonConnectionProfileSchema = z
  .object({
    ...savedEntityFields,
    id: connectionProfileIdSchema,
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
    id: executionTargetIdSchema,
    kind: z.literal("docker"),
    parentTargetId: executionTargetIdSchema,
    daemonProfileId: connectionProfileIdSchema,
    containerSelector,
    requestedUser: nonEmptyValue,
  })
  .strict();

export const localExecutionTargetSchema = z
  .object({
    ...savedEntityFields,
    id: executionTargetIdSchema,
    kind: z.literal("local"),
    platform: z.enum(["windows", "linux"]),
  })
  .strict();

export const sshExecutionTargetSchema = z
  .object({
    ...savedEntityFields,
    id: executionTargetIdSchema,
    kind: z.literal("ssh"),
    connectionProfileId: connectionProfileIdSchema,
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

const principalFields = {
  uid: z.number().int().nonnegative().optional(),
  gid: z.number().int().nonnegative().optional(),
  name: z.string().trim().min(1).max(256).optional(),
};

const localPrincipalSchema = z
  .object({
    ...principalFields,
  })
  .strict()
  .refine((principal) => principal.uid !== undefined || principal.name !== undefined, {
    message: "A verified principal needs a uid or name.",
  });

const posixPrincipalSchema = z
  .object({
    ...principalFields,
    uid: z.number().int().nonnegative(),
  })
  .strict();

const verifiedHostIdentityFields = {
  verifiedHostKey: z
    .string()
    .regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/),
  hostBootId: nonEmptyValue,
};

const runtimeBindingFields = {
  schemaVersion,
  bindingId: runtimeBindingIdSchema,
  targetId: executionTargetIdSchema,
  generation: bindingGeneration,
  runtimeInstanceId: runtimeInstanceIdSchema,
  arch: z.string().trim().min(1).max(64),
  workspaceRoots: z.array(targetPath).min(1).max(32),
  capabilities: z.array(runtimeCapabilitySchema).min(1).max(32),
};

export const dockerRuntimeBindingSchema = z
  .object({
    ...runtimeBindingFields,
    targetKind: z.literal("docker"),
    ...verifiedHostIdentityFields,
    dockerDaemonId: nonEmptyValue,
    containerId: z.string().regex(/^[0-9a-f]{64}$/),
    containerStartedAt: z.string().datetime({ offset: true }),
    containerState: z.literal("running"),
    principal: posixPrincipalSchema,
    platform: z.literal("linux"),
    defaultCwd: targetPath,
    shell: targetPath.nullable(),
    mountsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export const localRuntimeBindingSchema = z
  .object({
    ...runtimeBindingFields,
    targetKind: z.literal("local"),
    principal: localPrincipalSchema,
    platform: z.enum(["windows", "linux"]),
  })
  .strict();

export const sshRuntimeBindingSchema = z
  .object({
    ...runtimeBindingFields,
    targetKind: z.literal("ssh"),
    ...verifiedHostIdentityFields,
    principal: posixPrincipalSchema,
    platform: z.literal("linux"),
    defaultCwd: targetPath,
    shell: targetPath,
  })
  .strict();

export const runtimeBindingSchema = z.discriminatedUnion("targetKind", [
  localRuntimeBindingSchema,
  sshRuntimeBindingSchema,
  dockerRuntimeBindingSchema,
]).superRefine((binding, context) => {
  if (
    binding.targetKind === "docker" &&
    binding.shell === null &&
    binding.capabilities.some(
      (capability) =>
        capability === "process.shell" || capability === "terminal.pty",
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: "A container without a shell cannot advertise shell or PTY capabilities.",
    });
  }
});

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
    requestId: executionRequestIdSchema,
    operationId: operationIdSchema,
    agentSessionId: agentSessionIdSchema,
    expectedBindingId: runtimeBindingIdSchema,
    cwd: targetPath,
    command: executionCommandSchema,
    environmentProfileId: environmentProfileIdSchema,
    timeoutMs: z.number().int().min(1).max(86_400_000),
    approvalId: approvalIdSchema,
  })
  .strict();

export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
