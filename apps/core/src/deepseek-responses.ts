import type { AiModel } from "@stackbridge/protocol";

import {
  assistantResponseJsonSchema,
  type AssistantResponse,
} from "./assistant-response.js";

export interface ModelProviderRequest {
  baseUrl: string;
  model: string;
  apiKey: string;
  instructions: string;
  input: string;
  signal?: AbortSignal;
}

export interface ModelProvider {
  models(configuredModel?: string): AiModel[];
  complete(input: ModelProviderRequest): Promise<AssistantResponse>;
}

export class DeepSeekResponsesProvider implements ModelProvider {
  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  models(configuredModel?: string): AiModel[] {
    const suggestions: AiModel[] = [
      {
        id: "deepseek-flash",
        model: "deepseek-flash",
        displayName: "DeepSeek Flash",
        description: "Fast DeepSeek model",
        isDefault: true,
      },
      {
        id: "deepseek-v4-pro",
        model: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        description: "DeepSeek's higher-capability model",
        isDefault: false,
      },
    ];
    if (configuredModel === undefined || suggestions.some((item) => item.model === configuredModel)) {
      return suggestions;
    }
    return [...suggestions, {
      id: configuredModel,
      model: configuredModel,
      displayName: configuredModel,
      description: "Custom DeepSeek model",
      isDefault: false,
    }];
  }

  async complete(input: ModelProviderRequest): Promise<AssistantResponse> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${input.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          input: [
            {
              role: "developer",
              content: [{ type: "input_text", text: input.instructions }],
            },
            {
              role: "user",
              content: [{ type: "input_text", text: input.input }],
            },
          ],
          max_output_tokens: 4_096,
          text: {
            format: {
              type: "json_schema",
              name: "stackbridge_terminal_answer",
              schema: assistantResponseJsonSchema,
            },
          },
        }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      if (input.signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) {
        throw new DeepSeekRequestError(
          "deepseek_request_cancelled",
          408,
          "DeepSeek request was cancelled",
        );
      }
      throw new DeepSeekRequestError(
        "deepseek_connection_failed",
        502,
        "Could not reach the DeepSeek API",
      );
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new DeepSeekRequestError(
          "deepseek_authentication_failed",
          401,
          "DeepSeek rejected the API key",
        );
      }
      if (response.status === 429) {
        throw new DeepSeekRequestError(
          "deepseek_rate_limited",
          429,
          "DeepSeek rate limit reached; retry later",
        );
      }
      throw new DeepSeekRequestError(
        "deepseek_request_failed",
        502,
        `DeepSeek request failed (${response.status})`,
      );
    }
    let parsed: unknown;
    try {
      const payload = JSON.parse(await readBoundedResponse(response)) as unknown;
      parsed = JSON.parse(extractOutputText(payload)) as unknown;
    } catch (error) {
      if (error instanceof DeepSeekRequestError) throw error;
      throw new DeepSeekRequestError(
        "deepseek_invalid_response",
        502,
        "DeepSeek returned an invalid structured response",
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DeepSeekRequestError(
        "deepseek_invalid_response",
        502,
        "DeepSeek returned an invalid structured response",
      );
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.answer !== "string"
      || Buffer.byteLength(record.answer, "utf8") > 256 * 1_024
      || !Array.isArray(record.proposals)
      || record.proposals.length > 8
    ) {
      throw new DeepSeekRequestError(
        "deepseek_invalid_response",
        502,
        "DeepSeek returned an invalid structured response",
      );
    }
    const proposals = record.proposals.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        throw invalidResponseError();
      }
      const proposal = item as Record<string, unknown>;
      if (
        typeof proposal.purpose !== "string"
        || Buffer.byteLength(proposal.purpose, "utf8") > 2 * 1_024
        || typeof proposal.command !== "string"
        || Buffer.byteLength(proposal.command, "utf8") > 32 * 1_024
      ) throw invalidResponseError();
      return { purpose: proposal.purpose, command: proposal.command };
    });
    return { answer: record.answer, proposals };
  }
}

const maximumResponseBytes = 1 * 1_024 * 1_024;

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes) {
    throw invalidResponseError();
  }
  if (response.body === null) throw invalidResponseError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumResponseBytes) {
      await reader.cancel();
      throw invalidResponseError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function invalidResponseError(): DeepSeekRequestError {
  return new DeepSeekRequestError(
    "deepseek_invalid_response",
    502,
    "DeepSeek returned an invalid structured response",
  );
}

export class DeepSeekRequestError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

function extractOutputText(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DeepSeek returned an invalid response");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  const output = record.output;
  if (!Array.isArray(output)) throw new Error("DeepSeek returned an invalid response");
  const chunks: string[] = [];
  for (const item of output) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part !== null && typeof part === "object" && !Array.isArray(part)) {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") chunks.push(text);
      }
    }
  }
  if (chunks.length === 0) throw new Error("DeepSeek returned no output text");
  return chunks.join("");
}
