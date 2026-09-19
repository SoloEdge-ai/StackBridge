import { describe, expect, it } from "vitest";

import {
  flattenPanes,
  paneLayout,
  removePane,
  reusableTerminalRequest,
  splitPane,
  type TerminalPaneItem,
} from "./terminal-layout.js";

const firstPane: TerminalPaneItem = {
  id: "terminal-1",
  title: "PowerShell",
  kind: "local",
  createRequest: { kind: "local", cols: 120, rows: 32 },
};

const secondPane: TerminalPaneItem = {
  id: "terminal-2",
  title: "SSH",
  kind: "ssh",
  createRequest: { kind: "ssh", cols: 120, rows: 32, host: "dev", port: 22, user: "me" },
};

describe("terminal layout", () => {
  it("splits and collapses panes without changing the surviving pane", () => {
    const split = splitPane(paneLayout(firstPane), firstPane.id, secondPane, "horizontal");

    expect(flattenPanes(split).map((pane) => pane.id)).toEqual([
      "terminal-1",
      "terminal-2",
    ]);
    expect(removePane(split, firstPane.id)).toEqual(paneLayout(secondPane));
  });

  it("removes one-time deployment approval data from reusable requests", () => {
    expect(reusableTerminalRequest({
      kind: "ssh",
      cols: 120,
      rows: 32,
      host: "dev",
      port: 22,
      user: "me",
      deploymentApprovalId: "55c3de56-cd02-4d84-a6d2-0595239bf53f",
    })).toEqual({ kind: "ssh", cols: 120, rows: 32, host: "dev", port: 22, user: "me" });
  });
});
