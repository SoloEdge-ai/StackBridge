import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeploymentApprovalRequiredError,
  RemoteRuntimeManager,
  type RunRemoteProcess,
} from "./remote-runtime-manager.js";

const profile = {
  schemaVersion: 2 as const,
  id: "ssh.friden",
  displayName: "friden-dev-cube",
  kind: "ssh" as const,
  host: "friden-dev-cube",
  port: 22,
  user: "friden",
  proxyJumpProfileIds: [],
};

describe("RemoteRuntimeManager", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("describes the required deployment before writing to a host without a runtime", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stackbridge-artifact-"));
    directories.push(directory);
    const artifactPath = join(directory, "stackbridge-runtime");
    const contents = Buffer.from("runtime artifact");
    writeFileSync(artifactPath, contents);
    const digest = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
    let hostKeyFingerprint = "SHA256:test-fingerprint";
    const run = vi.fn<RunRemoteProcess>(async (command, args) => {
      if (command === "ssh" && args.at(-2) === "/usr/bin/uname") {
        return { exitCode: 0, stdout: "Linux x86_64\n", stderr: "" };
      }
      if (command === "ssh" && args.at(-2) === ".sbridge/current/stackbridge-runtime") {
        return { exitCode: 127, stdout: "", stderr: "not found" };
      }
      throw new Error(`unexpected process: ${command} ${args.join(" ")}`);
    });
    const manager = new RemoteRuntimeManager({
      artifacts: [{
        path: artifactPath,
        runtimeVersion: "0.1.0",
        protocolVersion: 2,
        platform: "linux",
        arch: "amd64",
        sha256: digest,
      }],
      run,
      resolveKnownHost: async () => ({
        lookupName: "friden-dev-cube",
        knownHostsLine: "friden-dev-cube ssh-ed25519 AAAAC3Nza-test",
        fingerprint: hostKeyFingerprint,
      }),
    });

    const pending = await manager.connect(profile, {}).catch((error: unknown) => error);
    expect(pending).toMatchObject({
      name: "DeploymentApprovalRequiredError",
      proposal: {
        reason: "missing",
        installRoot: "~/.sbridge",
        runtimeVersion: "0.1.0",
        runtimeDigest: digest,
        platform: "linux",
        arch: "amd64",
        user: "friden",
        host: "friden-dev-cube",
        hostKeyFingerprint: "SHA256:test-fingerprint",
        permissions: "0700 directories, 0755 runtime",
        cleanup: "Disconnect StackBridge, then remove ~/.sbridge",
      },
    } satisfies Partial<DeploymentApprovalRequiredError>);
    expect(run.mock.calls.every(([command]) => command === "ssh")).toBe(true);

    hostKeyFingerprint = "SHA256:changed-fingerprint";
    const approvedProposal = (pending as DeploymentApprovalRequiredError).proposal;
    await expect(manager.connect(profile, { approvedProposal })).rejects.toMatchObject({
      name: "DeploymentApprovalRequiredError",
      proposal: { hostKeyFingerprint: "SHA256:changed-fingerprint" },
    });
    expect(run.mock.calls.every(([command]) => command === "ssh")).toBe(true);
  });

  it("rejects a bundled artifact that does not match the fixed manifest digest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stackbridge-artifact-"));
    directories.push(directory);
    const artifactPath = join(directory, "stackbridge-runtime");
    writeFileSync(artifactPath, "tampered runtime");
    const run = vi.fn<RunRemoteProcess>(async () => ({
      exitCode: 0,
      stdout: "Linux x86_64\n",
      stderr: "",
    }));
    expect(() => new RemoteRuntimeManager({
      artifacts: [{
        path: artifactPath,
        runtimeVersion: "0.1.0",
        protocolVersion: 2,
        platform: "linux",
        arch: "amd64",
        sha256: `sha256:${"a".repeat(64)}`,
      }],
      run,
    })).toThrow(
      "Bundled runtime digest mismatch for linux/amd64",
    );
    expect(run).not.toHaveBeenCalled();
  });
});
