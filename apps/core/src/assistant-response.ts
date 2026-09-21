export interface AssistantResponse {
  answer: string;
  proposals: Array<{ purpose: string; command: string }>;
}

export const assistantResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "proposals"],
  properties: {
    answer: { type: "string" },
    proposals: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["purpose", "command"],
        properties: {
          purpose: { type: "string" },
          command: { type: "string" },
        },
      },
    },
  },
} as const;
