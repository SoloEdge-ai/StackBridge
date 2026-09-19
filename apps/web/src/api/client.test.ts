import { describe, expect, it } from "vitest";
import { apiError, errorMessage } from "./client.js";
import type { MessageKey } from "../i18n.js";

const translate = (message: MessageKey) => `translated:${message}`;

describe("api errors", () => {
  it("uses server messages before error codes", () => {
    expect(apiError({ message: "specific", error: "ignored" }, "fallback", translate)).toBe("specific");
  });

  it("localizes known error codes", () => {
    expect(apiError({ error: "terminal_session_not_found" }, "fallback", translate))
      .toBe("translated:这个终端已经关闭。");
  });

  it("normalizes unknown thrown values", () => {
    expect(errorMessage("bad", translate)).toBe("translated:发生未知错误");
  });
});
