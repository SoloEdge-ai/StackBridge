import { afterEach, describe, expect, it } from "vitest";

import {
  createSshRuntimeClient,
  type SshRuntimeClient,
} from "./ssh-runtime-client.js";

const liveDescribe = process.env.STACKBRIDGE_SSH_FIXTURE ? describe : describe.skip;

liveDescribe("SSH runtime client integration", () => {
  let client: SshRuntimeClient | undefined;

  afterEach(() => client?.close());

  it("handshakes and executes structured argv on the real Linux fixture", async () => {
    const host = process.env.STACKBRIDGE_SSH_FIXTURE!;
    client = await createSshRuntimeClient({
      schemaVersion: 2,
      id: "connection.integration-fixture",
      displayName: "SSH integration fixture",
      kind: "ssh",
      host,
      port: Number(process.env.STACKBRIDGE_SSH_PORT ?? 22),
      user: process.env.STACKBRIDGE_SSH_USER ?? "friden",
      proxyJumpProfileIds: [],
    });

    const identity = await client.handshake();
    const verifiedHostKey = await client.verifiedHostKey();
    expect(identity).toMatchObject({
      protocolVersion: 1,
      platform: "linux",
      principal: { uid: 1000, gid: 1000 },
    });
    expect(identity.hostBootId).not.toHaveLength(0);
    expect(verifiedHostKey).toBe(
      process.env.STACKBRIDGE_SSH_FINGERPRINT ??
        "SHA256:thbpCeLcrbAs6ri55e0/FQhVUPYoija4TjxJQh84Z90",
    );

    await expect(
      client.execute({
        cwd: "/tmp/stackbridge-m0b1",
        program: "/usr/bin/printf",
        args: ["%s\\n", "SSH 空格 ; $(literal) \"quoted\""],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "SSH 空格 ; $(literal) \"quoted\"\n",
      timedOut: false,
    });
  });

  it("binds and executes inside the real Docker fixture", async () => {
    const container = process.env.STACKBRIDGE_DOCKER_FIXTURE;
    if (!container) return;

    const host = process.env.STACKBRIDGE_SSH_FIXTURE!;
    client = await createSshRuntimeClient({
      schemaVersion: 2,
      id: "connection.integration-docker-fixture",
      displayName: "Docker integration fixture host",
      kind: "ssh",
      host,
      port: Number(process.env.STACKBRIDGE_SSH_PORT ?? 22),
      user: process.env.STACKBRIDGE_SSH_USER ?? "friden",
      proxyJumpProfileIds: [],
    });
    await client.handshake();
    await client.verifiedHostKey();

    const binding = await client.inspectDocker({
      contextName: "default",
      selector: container,
      requestedUser: "0:0",
      cwd: "/workspace",
    });
    expect(binding).toMatchObject({
      containerState: "running",
      principal: { uid: 0, gid: 0, name: "root" },
      defaultCwd: "/workspace",
    });

    await expect(
      client.executeDocker({
        contextName: "default",
        dockerDaemonId: binding.dockerDaemonId,
        containerId: binding.containerId,
        containerStartedAt: binding.containerStartedAt,
        expectedContainerInitStartTicks: binding.containerInitStartTicks,
        mountsDigest: binding.mountsDigest,
        user: "0:0",
        expectedUid: binding.principal.uid,
        expectedGid: binding.principal.gid,
        cwd: "/workspace",
        program: "/usr/bin/cat",
        args: ["identity.txt"],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("CONTAINER:ubuntu22-recreated"),
    });

    await expect(
      client.executeDocker({
        contextName: "default",
        dockerDaemonId: binding.dockerDaemonId,
        containerId: binding.containerId,
        containerStartedAt: binding.containerStartedAt,
        expectedContainerInitStartTicks: binding.containerInitStartTicks,
        mountsDigest: binding.mountsDigest,
        user: "0:0",
        expectedUid: binding.principal.uid,
        expectedGid: binding.principal.gid,
        cwd: "/workspace",
        program: "/bin/sh",
        args: ["-c", "printf '%s\\n' STACKBRIDGE_STALE_BINDING >&2; exit 124"],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      exitCode: 124,
      stderr: "STACKBRIDGE_STALE_BINDING\n",
      timedOut: false,
    });

    await expect(
      client.executeDocker({
        contextName: "default",
        dockerDaemonId: binding.dockerDaemonId,
        containerId: binding.containerId,
        containerStartedAt: binding.containerStartedAt,
        expectedContainerInitStartTicks: binding.containerInitStartTicks,
        mountsDigest: binding.mountsDigest,
        user: "0:0",
        expectedUid: binding.principal.uid,
        expectedGid: binding.principal.gid,
        cwd: "/workspace",
        program: "/bin/sh",
        args: ["-c", "sleep 5"],
        timeoutMs: 150,
      }),
    ).resolves.toMatchObject({ timedOut: true });

    await expect(
      client.executeDocker({
        contextName: "default",
        dockerDaemonId: binding.dockerDaemonId,
        containerId: binding.containerId,
        containerStartedAt: "2000-01-01T00:00:00Z",
        expectedContainerInitStartTicks: binding.containerInitStartTicks,
        mountsDigest: binding.mountsDigest,
        user: "0:0",
        expectedUid: binding.principal.uid,
        expectedGid: binding.principal.gid,
        cwd: "/workspace",
        program: "/usr/bin/true",
        args: [],
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "stale_binding" });
  });
});
