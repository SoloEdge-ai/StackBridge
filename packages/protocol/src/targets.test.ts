import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  connectionProfileSchema,
  executionRequestSchema,
  executionTargetSchema,
  runtimeBindingSchema,
} from "./index.js";

describe("target protocol", () => {
  it("accepts an SSH connection profile that references credentials instead of containing secrets", () => {
    const profile = {
      schemaVersion: 1,
      id: "profile.dev-main",
      displayName: "dev-main SSH",
      kind: "ssh",
      host: "dev-main.internal",
      port: 22,
      user: "developer",
      credentialRef: "windows-credential-manager:stackbridge/dev-main",
      proxyJumpProfileIds: ["profile.bastion"],
    };

    expect(connectionProfileSchema.parse(profile)).toEqual(profile);
  });

  it("accepts a Docker execution target as a logical selector rather than an instance identity", () => {
    const target = {
      schemaVersion: 1,
      id: "target.dev-main.ros-dev",
      displayName: "dev-main / ros-dev",
      kind: "docker",
      parentTargetId: "target.dev-main",
      daemonProfileId: "profile.dev-main.docker",
      containerSelector: "ros-dev",
      requestedUser: "1000:1000",
    };

    expect(executionTargetSchema.parse(target)).toEqual(target);
  });

  it("accepts an explicit Docker daemon profile", () => {
    const profile = {
      schemaVersion: 1,
      id: "profile.dev-main.docker",
      displayName: "dev-main Docker daemon",
      kind: "docker-daemon",
      contextName: "stackbridge-dev-main",
    };

    expect(connectionProfileSchema.parse(profile)).toEqual(profile);
  });

  it("accepts local and SSH execution target variants", () => {
    const targets = [
      {
        schemaVersion: 1,
        id: "target.local-windows",
        displayName: "This Windows PC",
        kind: "local",
        platform: "windows",
      },
      {
        schemaVersion: 1,
        id: "target.dev-main",
        displayName: "dev-main",
        kind: "ssh",
        connectionProfileId: "profile.dev-main",
      },
    ];

    expect(targets.map((target) => executionTargetSchema.parse(target))).toEqual(
      targets,
    );
  });

  it("requires a Docker binding to carry the complete verified instance identity", () => {
    const binding = {
      schemaVersion: 1,
      bindingId: "binding.ros-dev.20260917T095500Z",
      targetId: "target.dev-main.ros-dev",
      targetKind: "docker",
      generation: "7",
      runtimeInstanceId: "runtime.45a7",
      verifiedHostKey: "SHA256:AbCdEf0123456789+/hostFingerprint",
      hostBootId: "aa4bf2ca-5bc6-424f-98f9-22a671d323ce",
      dockerDaemonId: "daemon.dev-main.rootless",
      containerId: "8f3a1b2c4d5e6f708f3a1b2c4d5e6f708f3a1b2c4d5e6f708f3a1b2c4d5e6f70",
      containerStartedAt: "2026-09-17T09:55:00.000Z",
      principal: { uid: 1000, gid: 1000, name: "developer" },
      platform: "linux",
      arch: "x86_64",
      workspaceRoots: ["/workspace/stackbridge"],
      mountsDigest: `sha256:${"a".repeat(64)}`,
      capabilities: ["process.argv", "fs.read", "fs.write", "terminal.pty"],
    };
    const { containerStartedAt: _removed, ...incompleteBinding } = binding;

    expect(runtimeBindingSchema.parse(binding)).toEqual(binding);
    expect(runtimeBindingSchema.safeParse(incompleteBinding).success).toBe(false);
  });

  it("distinguishes local and SSH runtime bindings", () => {
    const common = {
      schemaVersion: 1,
      generation: "1",
      principal: { name: "developer" },
      arch: "x86_64",
      capabilities: ["process.argv", "fs.read"],
    };
    const bindings = [
      {
        ...common,
        bindingId: "binding.local.1",
        targetId: "target.local-windows",
        targetKind: "local",
        runtimeInstanceId: "runtime.local.1",
        platform: "windows",
        workspaceRoots: ["C:\\workspace\\stackbridge"],
      },
      {
        ...common,
        bindingId: "binding.dev-main.1",
        targetId: "target.dev-main",
        targetKind: "ssh",
        runtimeInstanceId: "runtime.dev-main.1",
        verifiedHostKey: "SHA256:AbCdEf0123456789+/hostFingerprint",
        hostBootId: "aa4bf2ca-5bc6-424f-98f9-22a671d323ce",
        platform: "linux",
        workspaceRoots: ["/workspace/stackbridge"],
      },
    ];

    expect(bindings.map((binding) => runtimeBindingSchema.parse(binding))).toEqual(
      bindings,
    );
  });

  it("accepts a binding-pinned argv request and rejects a caller-supplied target override", () => {
    const request = {
      schemaVersion: 1,
      requestId: "request.inspect-worktree",
      operationId: "operation.inspect-worktree",
      agentSessionId: "agent-session.dev-main",
      expectedBindingId: "binding.dev-main.1",
      cwd: "/workspace/stackbridge",
      command: {
        kind: "argv",
        program: "git",
        args: ["status", "--short"],
      },
      environmentProfileId: "environment.dev-main.base",
      timeoutMs: 120_000,
      approvalId: "approval.inspect-worktree",
    };

    expect(executionRequestSchema.parse(request)).toEqual(request);
    expect(
      executionRequestSchema.safeParse({
        ...request,
        targetId: "target.attacker-controlled",
      }).success,
    ).toBe(false);
  });

  it("keeps explicit shell execution distinct from argv execution", () => {
    const request = {
      schemaVersion: 1,
      requestId: "request.configure-environment",
      operationId: "operation.configure-environment",
      agentSessionId: "agent-session.dev-main",
      expectedBindingId: "binding.dev-main.1",
      cwd: "/workspace/stackbridge",
      command: {
        kind: "shell",
        shell: "/bin/sh",
        script: "set -eu\nprintf '%s\\n' ready",
      },
      environmentProfileId: "environment.dev-main.base",
      timeoutMs: 120_000,
      approvalId: "approval.configure-environment",
    };

    expect(executionRequestSchema.parse(request)).toEqual(request);
  });

  it("parses the language-neutral M0-B0 contract fixture", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../fixtures/m0-b0-target-contract.json", import.meta.url),
        "utf8",
      ),
    ) as {
      connectionProfiles: unknown[];
      executionTargets: unknown[];
      runtimeBindings: unknown[];
      executionRequests: unknown[];
    };

    expect({
      connectionProfiles: fixture.connectionProfiles.map((value) =>
        connectionProfileSchema.parse(value),
      ),
      executionTargets: fixture.executionTargets.map((value) =>
        executionTargetSchema.parse(value),
      ),
      runtimeBindings: fixture.runtimeBindings.map((value) =>
        runtimeBindingSchema.parse(value),
      ),
      executionRequests: fixture.executionRequests.map((value) =>
        executionRequestSchema.parse(value),
      ),
    }).toEqual(fixture);
  });
});
