import { describe, expect, it } from "vitest";

import { readTerminalTabs, writeTerminalTabs } from "./terminal-tabs-store.js";
import type { TerminalTab } from "./terminal-layout.js";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("terminal tabs store", () => {
  it("round-trips split terminal layouts", () => {
    const storage = new MemoryStorage();
    const tabs: TerminalTab[] = [{
      id: "tab-1",
      title: "PowerShell",
      kind: "local" as const,
      activePaneId: "terminal-2",
      layout: {
        type: "split" as const,
        direction: "horizontal" as const,
        first: {
          type: "pane" as const,
          pane: {
            id: "terminal-1",
            title: "PowerShell",
            kind: "local" as const,
            createRequest: { kind: "local", cols: 120, rows: 32 },
          },
        },
        second: {
          type: "pane" as const,
          pane: {
            id: "terminal-2",
            title: "SSH",
            kind: "ssh" as const,
            createRequest: { kind: "ssh", cols: 120, rows: 32, host: "dev", port: 22, user: "me" },
          },
        },
      },
    }];

    writeTerminalTabs(storage, tabs);

    expect(readTerminalTabs(storage)).toEqual(tabs);
  });

  it("migrates legacy tabs once and removes one-time approval fields", () => {
    const storage = new MemoryStorage();
    storage.setItem("stackbridge.terminalTabs.v2", JSON.stringify([{
      id: "terminal-1",
      title: "PowerShell",
      kind: "local",
      deploymentApprovalId: "approval-1",
    }]));

    expect(readTerminalTabs(storage)).toEqual([expect.objectContaining({
      id: "terminal-1",
      activePaneId: "terminal-1",
    })]);
    expect(storage.getItem("stackbridge.terminalTabs.v2")).toBeNull();
  });

  it("drops persisted panes whose creation request does not match their kind", () => {
    const storage = new MemoryStorage();
    storage.setItem("stackbridge.terminalTabs.v3", JSON.stringify([{
      id: "tab-1",
      title: "SSH",
      kind: "ssh",
      activePaneId: "terminal-1",
      layout: {
        type: "pane",
        pane: {
          id: "terminal-1",
          title: "SSH",
          kind: "ssh",
          createRequest: { kind: "local", cols: 120, rows: 32 },
        },
      },
    }]));

    expect(readTerminalTabs(storage)).toEqual([]);
  });

  it("reattaches remote legacy tabs without inventing reusable connection details", () => {
    const storage = new MemoryStorage();
    storage.setItem("stackbridge.terminalTabs.v2", JSON.stringify([{
      id: "terminal-ssh",
      title: "SSH",
      kind: "ssh",
    }]));

    const expected = [expect.objectContaining({
      id: "terminal-ssh",
      layout: expect.objectContaining({
        type: "pane",
        pane: expect.not.objectContaining({ createRequest: expect.anything() }),
      }),
    })];
    expect(readTerminalTabs(storage)).toEqual(expected);
    expect(readTerminalTabs(storage)).toEqual(expected);
    expect(storage.getItem("stackbridge.terminalTabs.v2")).toBeNull();
  });
});
