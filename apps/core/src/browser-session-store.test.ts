import { describe, expect, it } from "vitest";

import { BrowserSessionStore } from "./browser-session-store.js";

describe("browser session store", () => {
  it("expires server-side authentication even if a client replays the cookie", () => {
    let now = 1_000;
    const store = new BrowserSessionStore({
      ttlMs: 100,
      maxSessions: 2,
      now: () => now,
      tokenFactory: () => "session-a",
    });
    const token = store.issue();

    expect(store.has(token)).toBe(true);
    now = 1_101;
    expect(store.has(token)).toBe(false);
  });

  it("removes the oldest session when the bounded store is full", () => {
    const tokens = ["session-a", "session-b", "session-c"];
    const store = new BrowserSessionStore({
      ttlMs: 1_000,
      maxSessions: 2,
      now: () => 1_000,
      tokenFactory: () => tokens.shift()!,
    });

    const first = store.issue();
    const second = store.issue();
    const third = store.issue();

    expect(store.has(first)).toBe(false);
    expect(store.has(second)).toBe(true);
    expect(store.has(third)).toBe(true);
  });
});
