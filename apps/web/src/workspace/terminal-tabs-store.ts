import {
  findPane,
  flattenPanes,
  isTerminalKind,
  paneLayout,
  type PaneLayout,
  type TerminalPaneItem,
  type TerminalTab,
} from "./terminal-layout.js";

const tabsStorageKey = "stackbridge.terminalTabs.v3";
const legacyTabsStorageKey = "stackbridge.terminalTabs.v2";

export type TerminalTabsStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export function readTerminalTabs(storage: TerminalTabsStorage): TerminalTab[] {
  try {
    const stored = parseStoredTabs(storage.getItem(tabsStorageKey));
    if (stored.length > 0) return stored;

    const legacyValue = JSON.parse(
      storage.getItem(legacyTabsStorageKey) ?? "[]",
    ) as unknown;
    if (!Array.isArray(legacyValue)) return [];
    const migrated = legacyValue.flatMap((item): TerminalTab[] => {
      if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string") {
        return [];
      }
      if (!isTerminalKind(item.kind)) return [];
      const pane: TerminalPaneItem = {
        id: item.id,
        title: item.title,
        kind: item.kind,
        createRequest: { kind: "local", cols: 120, rows: 32 },
      };
      return [{
        id: item.id,
        title: item.title,
        kind: item.kind,
        layout: paneLayout(pane),
        activePaneId: pane.id,
      }];
    });
    if (migrated.length > 0) {
      writeTerminalTabs(storage, migrated);
      storage.removeItem(legacyTabsStorageKey);
    }
    return migrated;
  } catch {
    return [];
  }
}

export function writeTerminalTabs(
  storage: TerminalTabsStorage,
  tabs: TerminalTab[],
): void {
  storage.setItem(tabsStorageKey, JSON.stringify(tabs));
}

function parseStoredTabs(raw: string | null): TerminalTab[] {
  if (raw === null) return [];
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TerminalTab[] => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string") {
      return [];
    }
    if (!isTerminalKind(item.kind) || typeof item.activePaneId !== "string") return [];
    const layout = parsePaneLayout(item.layout, 0);
    if (!layout) return [];
    const activePaneId = findPane(layout, item.activePaneId)?.id
      ?? flattenPanes(layout)[0]?.id;
    if (!activePaneId) return [];
    return [{
      id: item.id,
      title: item.title,
      kind: item.kind,
      layout,
      activePaneId,
    }];
  });
}

function parsePaneLayout(value: unknown, depth: number): PaneLayout | undefined {
  if (depth > 32 || !isRecord(value)) return undefined;
  if (value.type === "pane" && isRecord(value.pane)) {
    const pane = value.pane;
    if (typeof pane.id !== "string" || typeof pane.title !== "string" || !isTerminalKind(pane.kind)) {
      return undefined;
    }
    const request = reusableTerminalSessionRequestSchema.safeParse(pane.createRequest);
    if (!request.success || (request.data.kind ?? "local") !== pane.kind) return undefined;
    return paneLayout({
      id: pane.id,
      title: pane.title,
      kind: pane.kind,
      createRequest: request.data,
    });
  }
  if (value.type !== "split" || (value.direction !== "horizontal" && value.direction !== "vertical")) {
    return undefined;
  }
  const first = parsePaneLayout(value.first, depth + 1);
  const second = parsePaneLayout(value.second, depth + 1);
  return first && second
    ? { type: "split", direction: value.direction, first, second }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
import { reusableTerminalSessionRequestSchema } from "@stackbridge/protocol";
