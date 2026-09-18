import { describe, expect, it } from "vitest";

import { TerminalQuickAskTrigger } from "./terminal-quick-ask-trigger.js";

describe("TerminalQuickAskTrigger", () => {
  it("holds a typed ?? sequence and opens Quick Ask without sending it", () => {
    const trigger = new TerminalQuickAskTrigger();

    expect(trigger.consume("?")).toEqual([]);
    expect(trigger.consume("?")).toEqual([]);
    expect(trigger.consume("\r")).toEqual([{ type: "quickAsk" }]);
  });

  it("handles a pasted ?? plus Enter as one input chunk", () => {
    const trigger = new TerminalQuickAskTrigger();

    expect(trigger.consume("??\r")).toEqual([{ type: "quickAsk" }]);
  });

  it("accepts full-width question marks from a Chinese input method", () => {
    const trigger = new TerminalQuickAskTrigger();

    expect(trigger.consume("？？\r")).toEqual([{ type: "quickAsk" }]);
  });

  it("accepts mixed half-width and full-width question marks", () => {
    const trigger = new TerminalQuickAskTrigger();

    expect(trigger.consume("?？\r")).toEqual([{ type: "quickAsk" }]);
  });

  it("flushes held question marks when the input is not the trigger", () => {
    const trigger = new TerminalQuickAskTrigger();

    expect(trigger.consume("?")).toEqual([]);
    expect(trigger.consume("x")).toEqual([{ type: "send", data: "?x" }]);
  });

  it("does not trigger inside an existing command line", () => {
    const trigger = new TerminalQuickAskTrigger();

    expect(trigger.consume("Write-Output ")).toEqual([
      { type: "send", data: "Write-Output " },
    ]);
    expect(trigger.consume("??\r")).toEqual([{ type: "send", data: "??\r" }]);
  });
});
