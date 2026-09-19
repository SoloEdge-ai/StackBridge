import { describe, expect, it } from "vitest";

import { canChangeConversation } from "./use-assistant-controller.js";

describe("assistant conversation lifecycle", () => {
  it("keeps the active conversation fixed while a turn is in flight", () => {
    expect(canChangeConversation(true)).toBe(false);
    expect(canChangeConversation(false)).toBe(true);
  });
});
