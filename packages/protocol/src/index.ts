import { z } from "zod";

export * from "./targets.js";

const terminalDimensionSchema = z.number().int().min(2).max(1_000);

export const createTerminalSessionRequestSchema = z.object({
  cols: terminalDimensionSchema,
  rows: terminalDimensionSchema,
});

export type CreateTerminalSessionRequest = z.infer<
  typeof createTerminalSessionRequestSchema
>;

export const terminalSessionSnapshotSchema = z.object({
  id: z.uuid(),
  state: z.enum(["running", "exited"]),
  cols: terminalDimensionSchema,
  rows: terminalDimensionSchema,
  replay: z.string(),
  exitCode: z.number().int().optional(),
  signal: z.number().int().optional(),
});

export type TerminalSessionSnapshot = z.infer<
  typeof terminalSessionSnapshotSchema
>;

export const clientTerminalMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input"),
    data: z.string().max(65_536),
  }),
  z.object({
    type: z.literal("resize"),
    cols: terminalDimensionSchema,
    rows: terminalDimensionSchema,
  }),
  z.object({
    type: z.literal("acquireWriteLease"),
  }),
]);

export type ClientTerminalMessage = z.infer<typeof clientTerminalMessageSchema>;

export const serverTerminalMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    sessionId: z.uuid(),
    state: z.enum(["running", "exited"]),
    cols: terminalDimensionSchema,
    rows: terminalDimensionSchema,
    replay: z.string(),
    writable: z.boolean(),
  }),
  z.object({
    type: z.literal("output"),
    data: z.string(),
  }),
  z.object({
    type: z.literal("writable"),
    writable: z.boolean(),
  }),
  z.object({
    type: z.literal("exit"),
    exitCode: z.number().int(),
    signal: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);

export type ServerTerminalMessage = z.infer<typeof serverTerminalMessageSchema>;
