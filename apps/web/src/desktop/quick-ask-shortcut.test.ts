import { describe, expect, it } from "vitest";

import { matchesBrowserShortcut } from "./quick-ask-shortcut.js";

describe("matchesBrowserShortcut", () => {
  it("matches F8 without modifiers", () => {
    expect(matchesBrowserShortcut({
      key: "F8",
      code: "F8",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    }, "F8")).toBe(true);
  });

  it("matches configured modifier shortcuts exactly", () => {
    expect(matchesBrowserShortcut({
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
    }, "Ctrl+Alt+K")).toBe(true);
    expect(matchesBrowserShortcut({
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
    }, "Ctrl+Alt+K")).toBe(false);
  });
});
