import { describe, expect, it } from "vitest";

import {
  clientTerminalMessageSchema,
  createTerminalSessionRequestSchema,
  terminalSessionSnapshotSchema,
  serverTerminalMessageSchema,
} from "./index.js";

describe("terminal protocol", () => {
  it("accepts the documented create-session dimensions", () => {
    expect(
      createTerminalSessionRequestSchema.parse({ cols: 120, rows: 32 }),
    ).toEqual({ cols: 120, rows: 32 });
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
  });
});
