import { describe, expect, it } from "vitest";

import { matchesDesktopShortcut } from "./desktop-shortcuts.js";

const defaultInput = {
  type: "keyDown",
  key: " ",
  code: "Space",
  control: true,
  shift: true,
  alt: false,
};

describe("matchesDesktopShortcut", () => {
  it("matches the default Quick Ask shortcut before the renderer handles it", () => {
    expect(matchesDesktopShortcut(defaultInput, "Ctrl+Shift+Space")).toBe(true);
  });

  it("does not intercept input method composition", () => {
    expect(matchesDesktopShortcut(
      { ...defaultInput, isComposing: true },
      "Ctrl+Shift+Space",
    )).toBe(false);
  });

  it("uses the shortcut selected in settings", () => {
    expect(matchesDesktopShortcut(
      { ...defaultInput, shift: false, alt: true, key: "k", code: "KeyK" },
      "Ctrl+Alt+K",
    )).toBe(true);
  });
});
