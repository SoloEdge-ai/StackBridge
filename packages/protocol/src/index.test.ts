import { describe, expect, it } from "vitest";

import {
  approvalDecisionRequestSchema,
  clientTerminalMessageSchema,
  createConversationRequestSchema,
  createTerminalSessionRequestSchema,
  createTurnRequestSchema,
  terminalSessionSnapshotSchema,
  serverTerminalMessageSchema,
} from "./index.js";

describe("terminal protocol", () => {
  it("accepts the documented create-session dimensions", () => {
    expect(
      createTerminalSessionRequestSchema.parse({ cols: 120, rows: 32 }),
    ).toEqual({ cols: 120, rows: 32 });
  });

  it("accepts verified SSH and Docker terminal creation intents", () => {
    expect(createTerminalSessionRequestSchema.parse({
      kind: "ssh",
      cols: 120,
      rows: 32,
      host: "friden-dev-cube",
      port: 22,
      user: "friden",
    })).toMatchObject({ kind: "ssh", host: "friden-dev-cube" });
    expect(createTerminalSessionRequestSchema.parse({
      kind: "docker",
      cols: 120,
      rows: 32,
      host: "friden-dev-cube",
      port: 22,
      user: "friden",
      contextName: "default",
      container: "stackbridge-m0b1-ubuntu22",
      containerUser: "root",
      cwd: "/workspace",
    })).toMatchObject({ kind: "docker", container: "stackbridge-m0b1-ubuntu22" });
  });

  it("rejects dimensions outside a usable terminal range", () => {
    expect(() =>
      createTerminalSessionRequestSchema.parse({ cols: 0, rows: 32 }),
    ).toThrow();
    expect(() =>
      createTerminalSessionRequestSchema.parse({ cols: 120, rows: 1_001 }),
    ).toThrow();
  });

  it("accepts input and resize client messages", () => {
    expect(clientTerminalMessageSchema.parse({ type: "input", data: "pwd\r" })).toEqual({
      type: "input",
      data: "pwd\r",
    });
    expect(clientTerminalMessageSchema.parse({ type: "resize", cols: 80, rows: 24 })).toEqual({
      type: "resize",
      cols: 80,
      rows: 24,
    });
    expect(clientTerminalMessageSchema.parse({ type: "acquireWriteLease" })).toEqual({
      type: "acquireWriteLease",
    });
  });

  it("rejects client attempts to forge server-only events", () => {
    expect(() =>
      clientTerminalMessageSchema.parse({ type: "exit", exitCode: 0 }),
    ).toThrow();
  });

  it("accepts a reconnect snapshot and live output", () => {
    expect(
      terminalSessionSnapshotSchema.parse({
        id: "b0dc5ee4-b313-4af8-9acd-01ef138e51d7",
        state: "running",
        cols: 120,
        rows: 32,
        replay: "PS> ",
      }),
    ).toMatchObject({ state: "running", replay: "PS> " });
    expect(
      serverTerminalMessageSchema.parse({
        type: "ready",
        sessionId: "b0dc5ee4-b313-4af8-9acd-01ef138e51d7",
        state: "running",
        cols: 120,
        rows: 32,
        replay: "PS> ",
        writable: true,
      }),
    ).toMatchObject({ type: "ready", state: "running" });
    expect(
      serverTerminalMessageSchema.parse({ type: "output", data: "hello\r\n" }),
    ).toEqual({ type: "output", data: "hello\r\n" });
    expect(
      serverTerminalMessageSchema.parse({ type: "writable", writable: false }),
    ).toEqual({ type: "writable", writable: false });
  });
});

describe("AI terminal workflow protocol", () => {
  it("keeps the browser request limited to user intent and current terminal", () => {
    expect(createConversationRequestSchema.parse({
      terminalSessionId: "b0dc5ee4-b313-4af8-9acd-01ef138e51d7",
      model: "gpt-5.6-sol",
    })).toEqual({
      schemaVersion: 2,
      terminalSessionId: "b0dc5ee4-b313-4af8-9acd-01ef138e51d7",
      model: "gpt-5.6-sol",
    });
    expect(createTurnRequestSchema.parse({
      terminalSessionId: "b0dc5ee4-b313-4af8-9acd-01ef138e51d7",
      message: "这个错误是什么意思？",
    })).toMatchObject({ message: "这个错误是什么意思？" });
    expect(() => createTurnRequestSchema.parse({
      terminalSessionId: "b0dc5ee4-b313-4af8-9acd-01ef138e51d7",
      message: "run it",
      bindingId: "forged-binding",
    })).toThrow();
  });

  it("accepts only explicit proposal decisions", () => {
    expect(approvalDecisionRequestSchema.parse({ decision: "execute" })).toEqual({
      schemaVersion: 2,
      decision: "execute",
    });
    expect(approvalDecisionRequestSchema.parse({ decision: "insert" })).toEqual({
      schemaVersion: 2,
      decision: "insert",
    });
    expect(approvalDecisionRequestSchema.parse({ decision: "reject" })).toEqual({
      schemaVersion: 2,
      decision: "reject",
    });
    expect(() => approvalDecisionRequestSchema.parse({
      decision: "execute",
      command: "forged command",
    })).toThrow();
  });
});
