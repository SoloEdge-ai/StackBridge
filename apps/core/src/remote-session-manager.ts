import { randomUUID } from "node:crypto";

import {
  createRemoteSessionRequestSchema,
  remoteExecutionRequestSchema,
  type CreateRemoteSessionRequest,
  type DeploymentProposal,
  type RemoteExecutionRequest,
  type RemoteExecutionResult,
  type RemoteSessionSnapshot,
} from "@stackbridge/protocol";

import {
  DeploymentApprovalRequiredError,
  type RemoteRuntimeConnection,
} from "./remote-runtime-manager.js";
import type { DockerBindingEvidence } from "./ssh-runtime-client.js";

interface ManagedRemoteSession {
  connection: RemoteRuntimeConnection;
  request: CreateRemoteSessionRequest;
  docker?: DockerBindingEvidence | undefined;
  snapshot: RemoteSessionSnapshot;
}

interface PendingDeploymentApproval {
  requestFingerprint: string;
  proposal: DeploymentProposal;
  expiresAt: number;
}

const deploymentApprovalTtlMs = 5 * 60_000;
const maximumPendingDeployments = 32;
const defaultMaximumRemoteSessions = 16;

export interface RemoteSessionService {
  connect(input: unknown): Promise<RemoteSessionSnapshot>;
  execute(sessionId: string, input: unknown): Promise<RemoteExecutionResult>;
  close(sessionId: string): boolean;
  disposeAll(): void;
}

interface RemoteRuntimeConnector {
  connect(
    profile: unknown,
    options: { approvedProposal?: DeploymentProposal; signal?: AbortSignal },
  ): Promise<RemoteRuntimeConnection>;
}

export class RemoteSessionManager implements RemoteSessionService {
  private readonly sessions = new Map<string, ManagedRemoteSession>();
  private readonly pendingDeployments = new Map<string, PendingDeploymentApproval>();

  constructor(
    private readonly runtimes: RemoteRuntimeConnector,
    private readonly maxSessions = defaultMaximumRemoteSessions,
  ) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
      throw new Error("maxSessions must be a positive integer");
    }
  }

  async connect(input: unknown): Promise<RemoteSessionSnapshot> {
    const request = createRemoteSessionRequestSchema.parse(input);
    if (this.sessions.size >= this.maxSessions) throw new RemoteSessionLimitError();
    const requestFingerprint = deploymentRequestFingerprint(request);
    let approvedProposal: DeploymentProposal | undefined;
    if (request.deploymentApprovalId !== undefined) {
      const pending = this.pendingDeployments.get(request.deploymentApprovalId);
      this.pendingDeployments.delete(request.deploymentApprovalId);
      if (
        pending === undefined ||
        pending.expiresAt <= Date.now() ||
        pending.requestFingerprint !== requestFingerprint
      ) {
        throw new InvalidDeploymentApprovalError();
      }
      approvedProposal = pending.proposal;
    }
    const profile = {
      schemaVersion: 2 as const,
      id: `ssh.${randomUUID()}`,
      displayName: request.host,
      kind: "ssh" as const,
      host: request.host,
      port: request.port,
      user: request.user,
      proxyJumpProfileIds: [],
    };
    let connection: RemoteRuntimeConnection;
    try {
      connection = await this.runtimes.connect(
        profile,
        approvedProposal === undefined ? {} : { approvedProposal },
      );
    } catch (error) {
      if (!(error instanceof DeploymentApprovalRequiredError)) throw error;
      this.expirePendingDeployments();
      if (this.pendingDeployments.size >= maximumPendingDeployments) {
        throw new Error("Too many pending runtime deployment approvals");
      }
      const approvalId = randomUUID();
      this.pendingDeployments.set(approvalId, {
        requestFingerprint,
        proposal: error.proposal,
        expiresAt: Date.now() + deploymentApprovalTtlMs,
      });
      throw new RemoteDeploymentApprovalRequiredError(approvalId, error.proposal);
    }
    try {
      const docker = request.docker === undefined
        ? undefined
        : await connection.client.inspectDocker({
            contextName: request.docker.contextName,
            selector: request.docker.selector,
            requestedUser: request.docker.requestedUser,
            cwd: request.docker.cwd,
          });
      const sessionId = randomUUID();
      const snapshot: RemoteSessionSnapshot = {
        schemaVersion: 2,
        sessionId,
        bindingId: randomUUID(),
        targetKind: docker === undefined ? "ssh" : "docker",
        host: request.host,
        user: request.user,
        hostKeyFingerprint: connection.hostKeyFingerprint,
        runtimeVersion: connection.identity.runtimeVersion,
        runtimeDigest: connection.identity.runtimeDigest,
        runtimeInstanceId: connection.identity.runtimeInstanceId,
        hostBootId: connection.identity.hostBootId,
        arch: connection.identity.arch,
        defaultCwd: docker?.defaultCwd ?? connection.identity.defaultCwd,
        shell: docker?.shell ?? connection.identity.shell,
        deployment: connection.deployment,
        ...(docker === undefined ? {} : { containerId: docker.containerId }),
      };
      this.sessions.set(sessionId, { connection, request, docker, snapshot });
      return snapshot;
    } catch (error) {
      connection.client.close();
      throw error;
    }
  }

  async execute(sessionId: string, input: unknown): Promise<RemoteExecutionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new RemoteSessionNotFoundError();
    const request = remoteExecutionRequestSchema.parse(input);
    if (session.docker === undefined || session.request.docker === undefined) {
      return await session.connection.client.execute(request);
    }
    return await session.connection.client.executeDocker({
      contextName: session.request.docker.contextName,
      dockerDaemonId: session.docker.dockerDaemonId,
      containerId: session.docker.containerId,
      containerStartedAt: session.docker.containerStartedAt,
      expectedContainerInitStartTicks: session.docker.containerInitStartTicks,
      mountsDigest: session.docker.mountsDigest,
      user: session.request.docker.requestedUser,
      expectedUid: session.docker.principal.uid,
      expectedGid: session.docker.principal.gid,
      cwd: request.cwd,
      program: request.program,
      args: request.args,
      timeoutMs: request.timeoutMs,
    });
  }

  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    session.connection.client.close();
    return true;
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.connection.client.close();
    this.sessions.clear();
    this.pendingDeployments.clear();
  }

  private expirePendingDeployments(): void {
    const now = Date.now();
    for (const [approvalId, pending] of this.pendingDeployments) {
      if (pending.expiresAt <= now) this.pendingDeployments.delete(approvalId);
    }
  }
}

export class RemoteSessionNotFoundError extends Error {
  constructor() {
    super("Remote session was not found");
    this.name = "RemoteSessionNotFoundError";
  }
}

export class RemoteSessionLimitError extends Error {
  constructor() {
    super("Remote session limit reached");
    this.name = "RemoteSessionLimitError";
  }
}

export class RemoteDeploymentApprovalRequiredError extends Error {
  constructor(
    readonly approvalId: string,
    readonly proposal: DeploymentApprovalRequiredError["proposal"],
  ) {
    super("Remote runtime deployment requires approval");
    this.name = "RemoteDeploymentApprovalRequiredError";
  }
}

export class InvalidDeploymentApprovalError extends Error {
  constructor() {
    super("Runtime deployment approval is invalid or expired");
    this.name = "InvalidDeploymentApprovalError";
  }
}

function deploymentRequestFingerprint(request: CreateRemoteSessionRequest): string {
  return JSON.stringify({
    host: request.host,
    port: request.port,
    user: request.user,
    docker: request.docker ?? null,
  });
}
