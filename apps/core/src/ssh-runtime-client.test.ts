import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  createSshRuntimeClient,
  managedRemoteRuntimePath,
  resolveKnownHost,
  type RuntimeProcess,
  type SpawnRuntimeProcess,
} from "./ssh-runtime-client.js";

class FakeRuntimeProcess extends EventEmitter implements RuntimeProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

const profile = {
  schemaVersion: 2 as const,
  id: "connection.friden-dev-cube",
  displayName: "friden-dev-cube",
  kind: "ssh" as const,
  host: "friden-dev-cube",
  port: 22,
  user: "friden",
  proxyJumpProfileIds: [],
};

const fixtureKnownHost = () => ({
  lookupName: "fixture",
  knownHostsLine:
    "fixture ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA3AnmOrrQ6AQh7kNZWQPhCvWVJAA6/0oJ9bmW1E4I1U",
  fingerprint: "SHA256:thbpCeLcrbAs6ri55e0/FQhVUPYoija4TjxJQh84Z90",
});

describe("SSH runtime client", () => {
  it("lets OpenSSH resolve trusted files with spaces before pinning the authenticated key", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const knownKey = fixtureKnownHost().knownHostsLine.split(" ")[2]!;
    const directory = mkdtempSync(join(tmpdir(), "stackbridge known hosts "));
    const trustedKeysPath = join(directory, "trusted keys");
    writeFileSync(trustedKeysPath, `fixture ssh-ed25519 ${knownKey}\n`);
    try {
      const loggedPath =
        globalThis.process.platform === "win32"
          ? trustedKeysPath.replace(/\\/g, "\\\\")
          : trustedKeysPath;
      const resolved = await resolveKnownHost(
        "fixture-alias",
        22,
        "friden",
        undefined,
        (command, args) => {
          calls.push({ command, args });
          if (command === "ssh" && args.includes("-G")) {
            return [
              "hostname 192.0.2.10",
              "port 22",
              "hostkeyalias none",
              "userknownhostsfile C:\\tmp\\path with space\\known_hosts C:\\tmp\\second file",
              "globalknownhostsfile __PROGRAMDATA__\\ssh/ssh_known_hosts",
              "",
            ].join("\n");
          }
          if (command === "ssh") {
            const logPath = args[args.indexOf("-E") + 1]!;
            writeFileSync(
              logPath,
              [
                `debug1: Server host key: ssh-ed25519 ${fixtureKnownHost().fingerprint}`,
                "debug1: Host 'fixture' is known and matches the ED25519 host key.",
                `debug1: Found key in ${loggedPath}:1`,
                'Authenticated to fixture ([192.0.2.10]:22) using "publickey".',
                "",
              ].join("\n"),
            );
            return "";
          }
          return "";
        },
      );

      expect(resolved).toEqual({
        lookupName: "192.0.2.10",
        knownHostsLine: `192.0.2.10 ssh-ed25519 ${knownKey}`,
        fingerprint: fixtureKnownHost().fingerprint,
      });
      expect(calls.some(({ command }) => command === "ssh-keygen")).toBe(false);
      expect(calls.some(({ command }) => command === "ssh-keyscan")).toBe(false);
      const probe = calls.find(
        ({ command, args }) => command === "ssh" && args.includes("-E"),
      )!;
      expect(probe.args).toEqual(
        expect.arrayContaining([
          "ControlPath=none",
          "KnownHostsCommand=none",
          "VerifyHostKeyDNS=no",
        ]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects SSH endpoint fields that could be interpreted as options", async () => {
    const spawn = vi.fn<SpawnRuntimeProcess>();

    await expect(
      createSshRuntimeClient(
        { ...profile, host: "-oProxyCommand=malicious-command" },
        { spawn },
      ),
    ).rejects.toThrow("SSH host is not safe for argv transport");
    await expect(
      createSshRuntimeClient(
        { ...profile, user: "friden\nProxyCommand malicious-command" },
        { spawn },
      ),
    ).rejects.toThrow("SSH user is not safe for argv transport");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps host-key preflight asynchronous and cancellable", async () => {
    const process = new FakeRuntimeProcess();
    const spawn = vi.fn<SpawnRuntimeProcess>(() => process);
    const controller = new AbortController();
    const creation = createSshRuntimeClient(profile, {
      spawn,
      signal: controller.signal,
      resolveKnownHost: (_host, _port, _user, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        }),
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).not.toHaveBeenCalled();
    controller.abort(new Error("fixture preflight cancelled"));
    await expect(creation).rejects.toThrow("fixture preflight cancelled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("launches only the fixed runtime command with strict host verification", async () => {
    const process = new FakeRuntimeProcess();
    const spawn = vi.fn<SpawnRuntimeProcess>(() => process);
    const client = await createSshRuntimeClient(profile, {
      spawn,
      resolveKnownHost: fixtureKnownHost,
    });
    const sshArgs = spawn.mock.calls[0]![1];
    const pinnedKnownHosts = sshArgs.find((argument) =>
      argument.startsWith("UserKnownHostsFile="),
    )!;
    expect(readFileSync(pinnedKnownHosts.slice("UserKnownHostsFile=".length), "utf8")).toBe(
      `${fixtureKnownHost().knownHostsLine}\n`,
    );

    expect(spawn).toHaveBeenCalledWith(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "FingerprintHash=sha256",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ProxyJump=none",
        "-o",
        "ProxyCommand=none",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ControlPersist=no",
        "-o",
        "KnownHostsCommand=none",
        "-o",
        "VerifyHostKeyDNS=no",
        "-o",
        "CheckHostIP=no",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        "NoHostAuthenticationForLocalhost=no",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "RemoteCommand=none",
        "-o",
        "RequestTTY=no",
        "-o",
        pinnedKnownHosts,
        "-o",
        `GlobalKnownHostsFile=${globalThis.process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-o",
        "HostKeyAlias=fixture",
        "-p",
        "22",
        "-l",
        "friden",
        "friden-dev-cube",
        managedRemoteRuntimePath,
        "stdio",
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );

    const verifiedHostKey = client.verifiedHostKey();
    process.stderr.write(
      [
        "debug1: Server host key: ssh-ed25519 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "debug1: Host 'forged-banner' is known and matches the ED25519 host key.",
        'Authenticated to forged-banner using "publickey".',
        "",
      ].join("\n"),
    );
    const handshakePromise = client.handshake();
    const request = await readRequest(process);
    process.stdout.write(
      `${JSON.stringify({
        version: 2,
        id: request.id,
        ok: true,
        result: {
          protocolVersion: 2,
          runtimeVersion: "0.1.0-test",
          runtimeDigest: `sha256:${"a".repeat(64)}`,
          runtimeInstanceId: "runtime.fixture.1",
          hostBootId: "boot.fixture.1",
          principal: { uid: 1000, gid: 1000, name: "friden" },
          platform: "linux",
          arch: "amd64",
          defaultCwd: "/home/friden",
          shell: "/usr/bin/zsh",
          capabilities: ["process.argv"],
        },
      })}\n`,
    );

    await expect(handshakePromise).resolves.toMatchObject({
      runtimeInstanceId: "runtime.fixture.1",
      principal: { uid: 1000, gid: 1000 },
    });
    await expect(verifiedHostKey).resolves.toBe(
      "SHA256:thbpCeLcrbAs6ri55e0/FQhVUPYoija4TjxJQh84Z90",
    );
    process.stderr.write(
      `${"x".repeat(16_384)}\ndebug1: Server host key: ssh-ed25519 SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n`,
    );
    await expect(client.verifiedHostKey()).resolves.toBe(
      "SHA256:thbpCeLcrbAs6ri55e0/FQhVUPYoija4TjxJQh84Z90",
    );
    client.close();
  });

  it("preserves structured argv without constructing a remote shell script", async () => {
    const process = new FakeRuntimeProcess();
    const client = await createSshRuntimeClient(profile, {
      spawn: authenticatedSpawn(process),
      resolveKnownHost: fixtureKnownHost,
    });

    const resultPromise = client.execute({
      cwd: "/workspace/含 空格",
      program: "/usr/bin/printf",
      args: ["%s\\n", "space ; $(literal) \"quoted\""],
      timeoutMs: 5_000,
    });
    const request = await readRequest(process);

    expect(request).toMatchObject({
      version: 2,
      method: "exec",
      params: {
        cwd: "/workspace/含 空格",
        program: "/usr/bin/printf",
        args: ["%s\\n", "space ; $(literal) \"quoted\""],
        timeoutMs: 5_000,
      },
    });

    process.stdout.write(
      `${JSON.stringify({
        version: 2,
        id: request.id,
        ok: true,
        result: {
          exitCode: 0,
          stdout: "space ; $(literal) \"quoted\"\n",
          stderr: "",
          timedOut: false,
        },
      })}\n`,
    );

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 0,
      stdout: "space ; $(literal) \"quoted\"\n",
    });
    client.close();
  });

  it("terminates a runtime that sends an oversized unterminated response", async () => {
    const process = new FakeRuntimeProcess();
    const client = await createSshRuntimeClient(profile, {
      spawn: authenticatedSpawn(process),
      resolveKnownHost: fixtureKnownHost,
    });
    const handshakePromise = client.handshake();
    await readRequest(process);

    process.stdout.write("x".repeat(13 * 1_048_576 + 1));

    await expect(handshakePromise).rejects.toThrow(
      "SSH runtime response exceeded the size limit",
    );
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("accepts the runtime's worst-case bounded stdout and stderr JSON", async () => {
    const process = new FakeRuntimeProcess();
    const client = await createSshRuntimeClient(profile, {
      spawn: authenticatedSpawn(process),
      resolveKnownHost: fixtureKnownHost,
    });
    const resultPromise = client.execute({
      cwd: "/workspace",
      program: "/usr/bin/fixture",
      args: [],
      timeoutMs: 5_000,
    });
    const request = await readRequest(process);
    const stdout = "\"".repeat(1_048_576);
    const stderr = "\\".repeat(1_048_576);

    process.stdout.write(
      `${JSON.stringify({
        version: 2,
        id: request.id,
        ok: true,
        result: { exitCode: 0, stdout, stderr, timedOut: false },
      })}\n`,
    );

    await expect(resultPromise).resolves.toMatchObject({ stdout, stderr });
    client.close();
  });

  it("rejects an oversized request locally without closing the runtime", async () => {
    const process = new FakeRuntimeProcess();
    const client = await createSshRuntimeClient(profile, {
      spawn: authenticatedSpawn(process),
      resolveKnownHost: fixtureKnownHost,
    });

    await expect(
      client.execute({
        cwd: "/workspace",
        program: "/usr/bin/printf",
        args: ['"'.repeat(600_000)],
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "request_too_large" });
    expect(process.kill).not.toHaveBeenCalled();

    const handshakePromise = client.handshake();
    const request = await readRequest(process);
    process.stdout.write(
      `${JSON.stringify({
        version: 2,
        id: request.id,
        ok: true,
        result: {
          protocolVersion: 2,
          runtimeVersion: "0.1.0-test",
          runtimeDigest: `sha256:${"b".repeat(64)}`,
          runtimeInstanceId: "runtime.fixture.after-oversize",
          hostBootId: "boot.fixture.after-oversize",
          principal: { uid: 1000, gid: 1000 },
          platform: "linux",
          arch: "amd64",
          defaultCwd: "/home/friden",
          shell: "/bin/sh",
          capabilities: ["process.argv"],
        },
      })}\n`,
    );
    await expect(handshakePromise).resolves.toMatchObject({
      runtimeInstanceId: "runtime.fixture.after-oversize",
    });
    client.close();
  });

  it("keeps the transport open for the requested execution timeout", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeRuntimeProcess();
      const client = await createSshRuntimeClient(profile, {
        spawn: authenticatedSpawn(process),
        resolveKnownHost: fixtureKnownHost,
        requestTimeoutMs: 10,
      });
      const resultPromise = client.execute({
        cwd: "/workspace",
        program: "/usr/bin/true",
        args: [],
        timeoutMs: 1_000,
      });
      const request = await readRequest(process);

      await vi.advanceTimersByTimeAsync(11);
      process.stdout.write(
        `${JSON.stringify({
          version: 2,
          id: request.id,
          ok: true,
          result: { exitCode: 0, stdout: "", stderr: "", timedOut: false },
        })}\n`,
      );

      await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes requests so deadlines start only when the runtime can handle them", async () => {
    const process = new FakeRuntimeProcess();
    const requests: Array<Record<string, unknown>> = [];
    process.stdin.on("data", (data: Buffer) => {
      requests.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
    });
    const client = await createSshRuntimeClient(profile, {
      spawn: authenticatedSpawn(process),
      resolveKnownHost: fixtureKnownHost,
    });

    const execution = client.execute({
      cwd: "/workspace",
      program: "/usr/bin/true",
      args: [],
      timeoutMs: 5_000,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const handshake = client.handshake();
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests).toHaveLength(1);

    process.stdout.write(
      `${JSON.stringify({
        version: 2,
        id: requests[0]!.id,
        ok: true,
        result: { exitCode: 0, stdout: "", stderr: "", timedOut: false },
      })}\n`,
    );
    await execution;
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests).toHaveLength(2);
    process.stdout.write(
      `${JSON.stringify({
        version: 2,
        id: requests[1]!.id,
        ok: true,
        result: {
          protocolVersion: 2,
          runtimeVersion: "0.1.0-test",
          runtimeDigest: `sha256:${"c".repeat(64)}`,
          runtimeInstanceId: "runtime.fixture.serial",
          hostBootId: "boot.fixture.serial",
          principal: { uid: 1000, gid: 1000 },
          platform: "linux",
          arch: "amd64",
          defaultCwd: "/home/friden",
          shell: "/bin/sh",
          capabilities: ["process.argv"],
        },
      })}\n`,
    );
    await handshake;
    client.close();
  });
});

async function readRequest(process: FakeRuntimeProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    process.stdin.once("data", (data: Buffer) => {
      resolve(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
    });
  });
}

function authenticatedSpawn(process: FakeRuntimeProcess): SpawnRuntimeProcess {
  return () => process;
}
