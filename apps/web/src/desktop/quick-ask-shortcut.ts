import { useEffect } from "react";

interface ShortcutInput {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function useQuickAskShortcut(shortcut: string, onToggle: () => void): void {
  useEffect(() => {
    const removeDesktopListener = window.stackBridgeDesktop?.onToggleQuickAsk(onToggle);
    window.stackBridgeDesktop?.setQuickAskShortcut(shortcut);
    return () => removeDesktopListener?.();
  }, [onToggle, shortcut]);

  useEffect(() => {
    const handleCompositionStart = () => window.stackBridgeDesktop?.setCompositionActive(true);
    const handleCompositionEnd = () => window.stackBridgeDesktop?.setCompositionActive(false);
    window.addEventListener("compositionstart", handleCompositionStart, true);
    window.addEventListener("compositionend", handleCompositionEnd, true);
    return () => {
      window.removeEventListener("compositionstart", handleCompositionStart, true);
      window.removeEventListener("compositionend", handleCompositionEnd, true);
      window.stackBridgeDesktop?.setCompositionActive(false);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !matchesBrowserShortcut(event, shortcut)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onToggle();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onToggle, shortcut]);
}

export function matchesBrowserShortcut(
  event: ShortcutInput,
  shortcut: string,
): boolean {
  const parts = shortcut.toLowerCase().split("+").map((item) => item.trim());
  const key = parts.at(-1);
  const eventKey = event.code === "Space" ? "space" : event.key.toLowerCase();
  return eventKey === key
    && event.ctrlKey === parts.includes("ctrl")
    && event.shiftKey === parts.includes("shift")
    && event.altKey === parts.includes("alt");
}
