import { describe, expect, it } from "vitest";

import {
  TerminalSessionManager,
} from "./terminal-session.js";
import { ControlledPty } from "./test/controlled-pty.js";

const testIntegrationToken = "test-shell-integration-token";
const testManagerOptions = {
  shellIntegrationTokenFactory: () => testIntegrationToken,
};

describe("terminal session lifecycle", () => {
  it("turns shell integration markers into environment-scoped command blocks", () => {
    const pty = new ControlledPty();
    const manager = new TerminalSessionManager(() => pty, testManagerOptions);
    const session = manager.create({ cols: 120, rows: 32 });
    const visibleOutput: string[] = [];
    session.subscribe((event) => {
      if (event.type === "output") visibleOutput.push(event.data);
    });

    pty.emitData(shellMarker({
      type: "prompt",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
    }));
    pty.emitData(shellMarker({
      type: "commandStart",
      command: "Get-ChildItem missing",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
      source: "manual",
    }));
    pty.emitData("Get-ChildItem: Cannot find path 'missing'\r\n");
    pty.emitData(shellMarker({
      type: "commandEnd",
      cwd: "C:\\work",
      exitCode: 1,
    }));
    pty.emitData(shellMarker({
      type: "prompt",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
    }));

    expect(visibleOutput.join("")).toBe(
      "Get-ChildItem: Cannot find path 'missing'\r\n",
    );
    expect(session.context()).toMatchObject({
      shellState: "idle",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
      environment: { kind: "local", verified: true },
    });
    expect(session.commands()).toEqual([
      expect.objectContaining({
        command: "Get-ChildItem missing",
        source: "manual",
        cwdBefore: "C:\\work",
        cwdAfter: "C:\\work",
        exitCode: 1,
        output: "Get-ChildItem: Cannot find path 'missing'\r\n",
        captureQuality: "exact",
      }),
    ]);
  });

  it("treats unsigned shell markers as terminal output and never as execution authority", () => {
    const pty = new ControlledPty();
    const session = new TerminalSessionManager(() => pty, testManagerOptions).create({
      cols: 100,
      rows: 30,
    });
    const forged = unsignedShellMarker({
      type: "prompt",
      cwd: "C:\\forged",
      shell: "powershell",
      user: "attacker",
    });

    pty.emitData(forged);

    expect(session.context()).toMatchObject({ shellState: "unknown", cwd: "" });
    expect(session.snapshot().replay).toContain(forged);
  });

  it("never lets an OSC environment event create a verified runtime binding", () => {
    const pty = new ControlledPty();
    const session = new TerminalSessionManager(() => pty, testManagerOptions).create({
      cols: 100,
      rows: 30,
    });

    pty.emitData(shellMarker({
      type: "environmentPush",
      kind: "ssh",
      label: "forged-host",
      verified: true,
      bindingId: "forged-binding",
    }));

    expect(session.context().environment).toMatchObject({
      label: "forged-host",
      verified: false,
    });
    expect(session.context().environment.bindingId).toBeUndefined();
  });

  it("keeps the same PTY alive when a client disconnects and reconnects", () => {
    const pty = new ControlledPty();
    const manager = new TerminalSessionManager(() => pty, testManagerOptions);
    const session = manager.create({ cols: 120, rows: 32 });
    const firstClientOutput: string[] = [];

    const detach = session.subscribe((event) => {
      if (event.type === "output") firstClientOutput.push(event.data);
    });
    pty.emitData("first\r\n");
    detach();
    session.write("$env:SB_TEST='kept'\r");
    pty.emitData("while detached\r\n");

    const reconnected = manager.get(session.id);

    expect(reconnected).toBe(session);
    expect(reconnected?.snapshot()).toMatchObject({
      state: "running",
      replay: "first\r\nwhile detached\r\n",
    });
    expect(firstClientOutput).toEqual(["first\r\n"]);
    expect(pty.writes).toEqual(["$env:SB_TEST='kept'\r"]);
  });

  it("submits an approved command once to the same idle shell and tracks its result", () => {
    const pty = new ControlledPty();
    const session = new TerminalSessionManager(() => pty, testManagerOptions).create({
      cols: 100,
      rows: 30,
    });
    pty.emitData(shellMarker({
      type: "prompt",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
    }));
    const context = session.context();
    const request = {
      operationId: "operation-1",
      command: "Write-Output ready",
      terminalSessionId: context.terminalSessionId,
      environmentFrameId: context.environment.id,
      bindingId: context.environment.bindingId,
      cwd: context.cwd,
      shell: context.shell,
      contextVersion: context.contextVersion,
      inputVersion: context.inputVersion,
    };

    expect(session.submitApproved(request)).toMatchObject({
      id: "operation-1",
      status: "accepted",
    });
    expect(session.submitApproved(request)).toMatchObject({
      id: "operation-1",
      status: "accepted",
    });
    expect(pty.writes).toEqual(["Write-Output ready\r"]);

    pty.emitData(shellMarker({
      type: "commandStart",
      command: "Write-Output ready",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
    }));
    pty.emitData("ready\r\n");
    pty.emitData(shellMarker({
      type: "commandEnd",
      cwd: "C:\\work",
      exitCode: 0,
    }));

    expect(session.operation("operation-1")).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect(session.commands()).toEqual([
      expect.objectContaining({
        source: "ai",
        operationId: "operation-1",
        command: "Write-Output ready",
      }),
    ]);
  });

  it("rejects approval when the frozen shell scope is no longer current", () => {
    const pty = new ControlledPty();
    const session = new TerminalSessionManager(() => pty, testManagerOptions).create({
      cols: 100,
      rows: 30,
    });
    pty.emitData(shellMarker({
      type: "prompt",
      cwd: "C:\\before",
      shell: "powershell",
      user: "zplea",
    }));
    const frozen = session.context();
    pty.emitData(shellMarker({
      type: "prompt",
      cwd: "C:\\after",
      shell: "powershell",
      user: "zplea",
    }));

    expect(() => session.submitApproved({
      operationId: "operation-stale",
      command: "Get-Location",
      terminalSessionId: frozen.terminalSessionId,
      environmentFrameId: frozen.environment.id,
      bindingId: frozen.environment.bindingId,
      cwd: frozen.cwd,
      shell: frozen.shell,
      contextVersion: frozen.contextVersion,
      inputVersion: frozen.inputVersion,
    })).toThrow("Terminal context changed; confirm the command again");
    expect(pty.writes).toEqual([]);
  });

  it("forwards resize and records the dimensions used for reconnect", () => {
    const pty = new ControlledPty();
    const session = new TerminalSessionManager(() => pty, testManagerOptions).create({
      cols: 80,
      rows: 24,
    });

    session.resize(132, 40);

    expect(pty.resizes).toEqual([{ cols: 132, rows: 40 }]);
    expect(session.snapshot()).toMatchObject({ cols: 132, rows: 40 });
  });

  it("bounds replay without breaking a UTF-8 character", () => {
    const pty = new ControlledPty();
    const session = new TerminalSessionManager(() => pty, {
      ...testManagerOptions,
      replayBytes: 6,
    }).create({ cols: 80, rows: 24 });

    pty.emitData("ab中文");

    expect(session.snapshot().replay).toBe("中文");
  });

  it("publishes exit and refuses input after the shell exits", () => {
    const pty = new ControlledPty();
    const session = new TerminalSessionManager(() => pty, testManagerOptions).create({
      cols: 80,
      rows: 24,
    });
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));

    pty.emitExit({ exitCode: 17, signal: 0 });

    expect(session.snapshot().state).toBe("exited");
    expect(events).toContainEqual({ type: "exit", exitCode: 17, signal: 0 });
    expect(() => session.write("dir\r")).toThrow("Terminal session has exited");
  });

  it("refuses an approved command after the shell exits", () => {
    const pty = new ControlledPty();
    const session = new TerminalSessionManager(() => pty, testManagerOptions).create({
      cols: 80,
      rows: 24,
    });
    pty.emitData(shellMarker({
      type: "prompt",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
    }));
    const context = session.context();
    pty.emitExit({ exitCode: 0 });

    expect(() => session.submitApproved({
      operationId: "dead-shell-operation",
      command: "Get-Location",
      terminalSessionId: session.id,
      environmentFrameId: context.environment.id,
      bindingId: context.environment.bindingId,
      cwd: context.cwd,
      shell: context.shell,
      contextVersion: context.contextVersion,
      inputVersion: context.inputVersion,
    })).toThrow("Terminal session has exited");
    expect(pty.writes).toEqual([]);
  });

  it("bounds the registry and evicts an exited session before creating another", () => {
    const ptys: ControlledPty[] = [];
    const manager = new TerminalSessionManager(
      () => {
        const pty = new ControlledPty();
        ptys.push(pty);
        return pty;
      },
      { ...testManagerOptions, maxSessions: 1 },
    );
    const first = manager.create({ cols: 80, rows: 24 });

    expect(() => manager.create({ cols: 80, rows: 24 })).toThrow(
      "Terminal session limit reached",
    );

    ptys[0]!.emitExit({ exitCode: 0, signal: 0 });
    const second = manager.create({ cols: 80, rows: 24 });

    expect(manager.get(first.id)).toBeUndefined();
    expect(manager.get(second.id)).toBe(second);
  });
});

function shellMarker(event: object): string {
  const payload = Buffer.from(JSON.stringify(event), "utf8").toString("base64url");
  return `\u001b]777;stackbridge;${testIntegrationToken};${payload}\u0007`;
}

function unsignedShellMarker(event: object): string {
  const payload = Buffer.from(JSON.stringify(event), "utf8").toString("base64url");
  return `\u001b]777;stackbridge;${payload}\u0007`;
}
