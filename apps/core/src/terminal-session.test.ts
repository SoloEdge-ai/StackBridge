import { describe, expect, it } from "vitest";

import {
  TerminalSessionManager,
  type PtyExitEvent,
  type PtyProcess,
} from "./terminal-session.js";

class ControlledPty implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  readonly dataListeners = new Set<(data: string) => void>();
  readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {}

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

describe("terminal session lifecycle", () => {
  it("keeps the same PTY alive when a client disconnects and reconnects", () => {
    const pty = new ControlledPty();
    const manager = new TerminalSessionManager(() => pty);
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

  it("forwards resize and records the dimensions used for reconnect", () => {
    const pty = new ControlledPty();
    const session = new TerminalSessionManager(() => pty).create({
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
      replayBytes: 6,
    }).create({ cols: 80, rows: 24 });

    pty.emitData("ab中文");

    expect(session.snapshot().replay).toBe("中文");
  });

  it("publishes exit and refuses input after the shell exits", () => {
    const pty = new ControlledPty();
    const session = new TerminalSessionManager(() => pty).create({
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
});
