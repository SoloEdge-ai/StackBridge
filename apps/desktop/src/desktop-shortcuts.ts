export interface DesktopKeyboardInput {
  type: string;
  key: string;
  code?: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  isAutoRepeat?: boolean;
  isComposing?: boolean;
}

export function matchesDesktopShortcut(
  input: DesktopKeyboardInput,
  shortcut: string,
): boolean {
  if (input.type !== "keyDown" || input.isAutoRepeat || input.isComposing) return false;
  const parts = shortcut.toLowerCase().split("+").map((part) => part.trim());
  const key = parts.at(-1);
  const inputKey = input.code === "Space" || input.key === " "
    ? "space"
    : input.key.toLowerCase();
  return inputKey === key
    && input.control === parts.includes("ctrl")
    && input.shift === parts.includes("shift")
    && input.alt === parts.includes("alt");
}
