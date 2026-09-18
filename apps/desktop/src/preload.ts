import { contextBridge, ipcRenderer } from "electron";

const toggleQuickAskChannel = "stackbridge:toggle-quick-ask";
const setQuickAskShortcutChannel = "stackbridge:set-quick-ask-shortcut";
const setCompositionActiveChannel = "stackbridge:set-composition-active";

contextBridge.exposeInMainWorld("stackBridgeDesktop", {
  onToggleQuickAsk(callback: () => void): () => void {
    const listener = () => callback();
    ipcRenderer.on(toggleQuickAskChannel, listener);
    return () => ipcRenderer.removeListener(toggleQuickAskChannel, listener);
  },
  setQuickAskShortcut(shortcut: string): void {
    ipcRenderer.send(setQuickAskShortcutChannel, shortcut);
  },
  setCompositionActive(active: boolean): void {
    ipcRenderer.send(setCompositionActiveChannel, active);
  },
});
