import type { IncomingMessage } from "node:http";

import { BrowserSessionStore } from "./browser-session-store.js";

export const browserSessionCookieName = "stackbridge_session";

export function authenticatedBrowserSession(
  request: IncomingMessage,
  browserSessions: BrowserSessionStore,
): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader === undefined) return undefined;
  for (const cookie of cookieHeader.split(";")) {
    const [name, value] = cookie.trim().split("=", 2);
    if (name === browserSessionCookieName && value && browserSessions.has(value)) return value;
  }
  return undefined;
}
