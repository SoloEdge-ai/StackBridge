import { serverTerminalMessageSchema } from "@stackbridge/protocol";

export function decodeServerMessage(raw: unknown) {
  try {
    const text = typeof raw === "string" ? raw : raw instanceof Blob ? undefined : String(raw);
    return text === undefined ? undefined : serverTerminalMessageSchema.parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}
