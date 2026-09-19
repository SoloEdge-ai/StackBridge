import type { MessageKey } from "../i18n.js";

export type Translate = (source: MessageKey) => string;

export async function api<T>(url: string, init: RequestInit | undefined, t: Translate): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const fallback = t("请求失败");
    throw new Error(apiError(payload, `${fallback} (${response.status})`, t));
  }
  return payload as T;
}

export function apiError(payload: Record<string, unknown>, fallback: string, t: Translate): string {
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error !== "string") return fallback;
  const messages: Record<string, MessageKey> = {
    terminal_session_limit_reached: "终端数量已达上限，请先关闭不用的标签。",
    remote_session_limit_reached: "远端连接数量已达上限，请先关闭不用的标签。",
    remote_terminals_unavailable: "远端终端服务当前不可用。",
    terminal_session_not_found: "这个终端已经关闭。",
  };
  const message = messages[payload.error];
  return message === undefined ? payload.error : t(message);
}

export function errorMessage(reason: unknown, t: Translate): string {
  return reason instanceof Error ? reason.message : t("发生未知错误");
}

export class DeploymentRequired extends Error {
  constructor(readonly payload: Record<string, unknown>) {
    super("Remote runtime deployment requires approval");
  }
}
