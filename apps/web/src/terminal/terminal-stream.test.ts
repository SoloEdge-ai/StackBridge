import { describe, expect, it } from "vitest";
import { decodeServerMessage } from "./terminal-stream.js";

describe("terminal stream decoding", () => {
  it("accepts valid server frames", () => {
    expect(decodeServerMessage(JSON.stringify({ type: "output", data: "ok" })))
      .toEqual({ type: "output", data: "ok" });
  });

  it("rejects binary and malformed frames", () => {
    expect(decodeServerMessage(new Blob(["bad"]))).toBeUndefined();
    expect(decodeServerMessage("not-json")).toBeUndefined();
  });
});
