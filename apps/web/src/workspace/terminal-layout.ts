export type TerminalKind = "local" | "ssh" | "docker";
export type SplitDirection = "horizontal" | "vertical";

export interface TerminalPaneItem {
  id: string;
  title: string;
  kind: TerminalKind;
  createRequest: Record<string, unknown>;
}

export type PaneLayout =
  | { type: "pane"; pane: TerminalPaneItem }
  | {
    type: "split";
    direction: SplitDirection;
    first: PaneLayout;
    second: PaneLayout;
  };

export interface TerminalTab {
  id: string;
  title: string;
  kind: TerminalKind;
  layout: PaneLayout;
  activePaneId: string;
}

export function paneLayout(pane: TerminalPaneItem): PaneLayout {
  return { type: "pane", pane };
}

export function reusableTerminalRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const { deploymentApprovalId: _deploymentApprovalId, ...request } = body;
  return request;
}

export function flattenPanes(layout: PaneLayout): TerminalPaneItem[] {
  return layout.type === "pane"
    ? [layout.pane]
    : [...flattenPanes(layout.first), ...flattenPanes(layout.second)];
}

export function findPane(
  layout: PaneLayout,
  paneId: string,
): TerminalPaneItem | undefined {
  if (layout.type === "pane") {
    return layout.pane.id === paneId ? layout.pane : undefined;
  }
  return findPane(layout.first, paneId) ?? findPane(layout.second, paneId);
}

export function splitPane(
  layout: PaneLayout,
  paneId: string,
  pane: TerminalPaneItem,
  direction: SplitDirection,
): PaneLayout {
  if (layout.type === "pane") {
    return layout.pane.id === paneId
      ? { type: "split", direction, first: layout, second: paneLayout(pane) }
      : layout;
  }
  if (findPane(layout.first, paneId)) {
    return { ...layout, first: splitPane(layout.first, paneId, pane, direction) };
  }
  return { ...layout, second: splitPane(layout.second, paneId, pane, direction) };
}

export function removePane(
  layout: PaneLayout,
  paneId: string,
): PaneLayout | undefined {
  if (layout.type === "pane") {
    return layout.pane.id === paneId ? undefined : layout;
  }
  const first = removePane(layout.first, paneId);
  const second = removePane(layout.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
}

export function isTerminalKind(value: unknown): value is TerminalKind {
  return value === "local" || value === "ssh" || value === "docker";
}
