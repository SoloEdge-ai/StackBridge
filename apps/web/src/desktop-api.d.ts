interface Window {
  stackBridgeDesktop?: {
    onToggleQuickAsk(callback: () => void): () => void;
    setQuickAskShortcut(shortcut: string): void;
    setCompositionActive(active: boolean): void;
  };
}
