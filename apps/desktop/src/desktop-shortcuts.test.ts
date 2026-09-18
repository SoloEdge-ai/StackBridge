import { describe, expect, it } from "vitest";

import { matchesDesktopShortcut } from "./desktop-shortcuts.js";

const defaultInput = {
  type: "keyDown",
  key: "F8",
  code: "F8",
  control: false,
  shift: false,
  alt: false,
};

describe("matchesDesktopShortcut", () => {
  it("matches the default Quick Ask shortcut before the renderer handles it", () => {
    expect(matchesDesktopShortcut(defaultInput, "F8")).toBe(true);
  });

  it("does not intercept input method composition", () => {
    expect(matchesDesktopShortcut(
      { ...defaultInput, isComposing: true },
      "F8",
    )).toBe(false);
  });

  it("uses the shortcut selected in settings", () => {
    expect(matchesDesktopShortcut(
      { ...defaultInput, control: true, shift: false, alt: true, key: "k", code: "KeyK" },
      "Ctrl+Alt+K",
    )).toBe(true);
  });
});
