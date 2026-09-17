import { describe, expect, it, vi } from "vitest";

import { DeploymentApprovalRequiredError } from "./remote-runtime-manager.js";
import type { RemoteRuntimeConnection } from "./remote-runtime-manager.js";
import {
  InvalidDeploymentApprovalError,
  RemoteDeploymentApprovalRequiredError,
  RemoteSessionLimitError,
  RemoteSessionManager,
} from "./remote-session-manager.js";

const proposal = {
  reason: "missing" as const,
  installRoot: "~/.sbridge" as const,
  runtimeVersion: "0.1.0-dev",
  runtimeDigest: `sha256:${"a".repeat(64)}`,
  platform: "linux" as const,
  arch: "amd64" as const,
  user: "friden",
  host: "friden-dev-cube",
  hostKeyFingerprint: "SHA256:test",
  permissions: "0700 directories, 0755 runtime" as const,
  cleanup: "Disconnect StackBridge, then remove ~/.sbridge" as const,
};

const request = {
  host: "friden-dev-cube",
  port: 22,
  user: "friden",
};

describe("RemoteSessionManager deployment approvals", () => {
  it("makes approval one-time and binds it to the exact connection request", async () => {
    const connect = vi.fn(async () => {
      throw new DeploymentApprovalRequiredError(proposal);
    });
    const manager = new RemoteSessionManager({ connect });
    const pending = await manager.connect(request).catch((error: unknown) => error);

    expect(pending).toBeInstanceOf(RemoteDeploymentApprovalRequiredError);
    const approvalId = (pending as RemoteDeploymentApprovalRequiredError).approvalId;

    await expect(manager.connect({
      ...request,
      host: "other-host",
      deploymentApprovalId: approvalId,
    })).rejects.toBeInstanceOf(InvalidDeploymentApprovalError);
    await expect(manager.connect({
      ...request,
      deploymentApprovalId: approvalId,
    })).rejects.toBeInstanceOf(InvalidDeploymentApprovalError);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("rejects new remote processes after the configured session limit", async () => {
    const close = vi.fn();
    const connection = {
      client: { close },
      identity: {
        runtimeVersion: "0.1.0-dev",
        runtimeDigest: `sha256:${"a".repeat(64)}`,
        protocolVersion: 2,
        platform: "linux",
        arch: "amd64",
        defaultCwd: "/home/friden",
        shell: "/bin/bash",
      },
      hostKeyFingerprint: "SHA256:test",
      deployment: "reused",
    } as unknown as RemoteRuntimeConnection;
    const connect = vi.fn(async () => connection);
    const manager = new RemoteSessionManager({ connect }, 1);

    await expect(manager.connect(request)).resolves.toMatchObject({ host: request.host });
    await expect(manager.connect(request)).rejects.toBeInstanceOf(RemoteSessionLimitError);
    expect(connect).toHaveBeenCalledTimes(1);
    manager.disposeAll();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
