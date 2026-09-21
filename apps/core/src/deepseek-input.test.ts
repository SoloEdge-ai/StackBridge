import type { ConversationMessage } from "@stackbridge/protocol";
import { describe, expect, it } from "vitest";

import type { AgentEngineContext } from "./conversation-service.js";
import { formatDeepSeekInput } from "./deepseek-input.js";

describe("DeepSeek input bounds", () => {
  it("keeps serialized history and terminal context independently within 64 KiB", () => {
    const huge = "栈".repeat(40_000);
    const history: ConversationMessage[] = [{
      schemaVersion: 2,
      id: "00000000-0000-4000-8000-000000000001",
      role: "assistant",
      content: huge,
      createdAt: "2026-09-21T00:00:00.000Z",
    }];
    const context: AgentEngineContext = {
      terminalSessionId: "00000000-0000-4000-8000-000000000002",
      environment: {
        id: "environment.test",
        kind: "local",
        label: huge,
        verified: true,
      },
      environmentStack: [],
      cwd: huge,
      shell: "powershell",
      user: "tester",
      shellState: "idle",
      recentCommands: [{
        id: "command.test",
        environmentFrameId: "environment.test",
        source: "manual",
        command: huge,
        cwd: "C:\\workspace",
        output: huge,
        outputTruncated: false,
        captureQuality: "exact",
      }],
      contextTruncated: false,
    };

    const formatted = formatDeepSeekInput({
      conversationId: "00000000-0000-4000-8000-000000000003",
      model: "deepseek-test",
      message: "Explain",
      history,
      context,
    });

    for (const tag of ["conversation_history", "terminal_context"]) {
      const value = taggedBlock(formatted, tag);
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64 * 1_024);
      expect(() => JSON.parse(value)).not.toThrow();
    }
  });
});

function taggedBlock(input: string, tag: string): string {
  return new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(input)![1]!;
}
