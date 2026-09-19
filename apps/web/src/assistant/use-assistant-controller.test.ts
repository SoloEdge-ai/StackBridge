import { describe, expect, it } from "vitest";
import { type ConversationSnapshot } from "@stackbridge/protocol";

import { transitionConversationSelection } from "./use-assistant-controller.js";

function conversation(id: string): ConversationSnapshot {
  return {
    schemaVersion: 2,
    id,
    title: id,
    model: "gpt-5.6-luna",
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    messages: [],
    proposals: [],
  };
}

describe("assistant conversation lifecycle", () => {
  const first = conversation("first");
  const second = conversation("second");

  it("keeps the selected conversation fixed while a turn is in flight", () => {
    expect(transitionConversationSelection(
      first,
      [first, second],
      true,
      { type: "select", id: second.id },
    )).toBe(first);
    expect(transitionConversationSelection(
      first,
      [first, second],
      true,
      { type: "new" },
    )).toBe(first);
  });

  it("applies selection changes after the turn is idle", () => {
    expect(transitionConversationSelection(
      first,
      [first, second],
      false,
      { type: "select", id: second.id },
    )).toBe(second);
    expect(transitionConversationSelection(
      first,
      [first, second],
      false,
      { type: "new" },
    )).toBeUndefined();
  });
});
