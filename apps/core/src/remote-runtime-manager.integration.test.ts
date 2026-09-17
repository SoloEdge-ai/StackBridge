import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  DeploymentApprovalRequiredError,
  RemoteRuntimeManager,
} from "./remote-runtime-manager.js";
import type { SshRuntimeClient } from "./ssh-runtime-client.js";

const liveDescribe = process.env.STACKBRIDGE_SSH_FIXTURE ? describe : describe.skip;

liveDescribe("remote runtime deployment integration", () => {
  let client: SshRuntimeClient | undefined;

  afterEach(() => client?.close());

  it("installs or reuses ~/.sbridge and executes structured argv", async () => {
    const artifactPath = fileURLToPath(
      new URL("../../../runtime/bin/linux-amd64/stackbridge-runtime", import.meta.url),
    );
    const digest = `sha256:${createHash("sha256").update(readFileSync(artifactPath)).digest("hex")}`;
    const manager = new RemoteRuntimeManager({
      artifacts: [{
        path: artifactPath,
        runtimeVersion: "0.1.0-dev",
        protocolVersion: 2,
        platform: "linux",
        arch: "amd64",
        sha256: digest,
      }],
    });
    const host = process.env.STACKBRIDGE_SSH_FIXTURE!;
    const port = Number(process.env.STACKBRIDGE_SSH_PORT ?? 22);
    const user = process.env.STACKBRIDGE_SSH_USER ?? "friden";
    const connection = await manager.connect({
      schemaVersion: 2,
      id: "connection.auto-deploy-fixture",
      displayName: "Auto deploy fixture",
      kind: "ssh",
      host,
      port,
      user,
      proxyJumpProfileIds: [],
    }, {}).catch(async (error: unknown) => {
      if (!(error instanceof DeploymentApprovalRequiredError)) throw error;
      return await manager.connect({
        schemaVersion: 2,
        id: "ssh.live.install-approved",
        displayName: host,
        kind: "ssh",
        host,
        port,
        user,
        proxyJumpProfileIds: [],
      }, { approvedProposal: error.proposal });
    });
    client = connection.client;

    expect(connection.identity).toMatchObject({
      protocolVersion: 2,
      runtimeVersion: "0.1.0-dev",
      runtimeDigest: digest,
      platform: "linux",
      arch: "amd64",
    });
    expect(connection.hostKeyFingerprint).toMatch(/^SHA256:/);
    const result = await client.execute({
      cwd: connection.identity.defaultCwd,
      program: "/usr/bin/printf",
      args: ["%s", "STACKBRIDGE_AUTO_DEPLOY_OK"],
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "STACKBRIDGE_AUTO_DEPLOY_OK",
      stderr: "",
      timedOut: false,
    });

    client.close();
    const reused = await manager.connect({
      schemaVersion: 2,
      id: "connection.auto-deploy-fixture.reuse",
      displayName: "Auto deploy fixture reuse",
      kind: "ssh",
      host,
      port,
      user,
      proxyJumpProfileIds: [],
    }, {});
    client = reused.client;
    expect(reused.deployment).toBe("reused");
  });
});
