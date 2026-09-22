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
  if (typeof payload.error !== "string") return fallback;
  const messages: Record<string, MessageKey> = {
    context_preparation_expired: "上下文预览已过期，请检查刷新后的范围并重新发送。",
    context_preparation_mismatch: "上下文不属于当前对话或终端，请重新选择。",
    conversation_turn_in_progress: "当前对话仍在处理中，请稍后再发送。",
    conversation_turn_cancelled: "本次请求已停止，附件未标记为发送成功。",
    terminal_session_limit_reached: "终端数量已达上限，请先关闭不用的标签。",
    remote_session_limit_reached: "远端连接数量已达上限，请先关闭不用的标签。",
    remote_terminals_unavailable: "远端终端服务当前不可用。",
    terminal_session_not_found: "这个终端已经关闭。",
    ai_provider_unavailable: "当前 AI 提供方不可用。",
    deepseek_api_key_required: "需要先配置 DeepSeek API Key。",
    deepseek_authentication_failed: "DeepSeek 拒绝了这个 API Key。",
    deepseek_rate_limited: "DeepSeek 请求频率受限，请稍后重试。",
    deepseek_request_cancelled: "DeepSeek 请求已停止。",
    deepseek_request_timeout: "DeepSeek 请求超时。",
    deepseek_connection_failed: "无法连接 DeepSeek API。",
    deepseek_invalid_response: "DeepSeek 返回了无效响应。",
  };
  const message = messages[payload.error];
  if (message !== undefined) return t(message);
  return typeof payload.message === "string" ? payload.message : payload.error;
}

export function errorMessage(reason: unknown, t: Translate): string {
  return reason instanceof Error ? reason.message : t("发生未知错误");
}

export class DeploymentRequired extends Error {
  constructor(readonly payload: Record<string, unknown>) {
    super("Remote runtime deployment requires approval");
  }
}
