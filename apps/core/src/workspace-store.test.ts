import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CommandProposal,
  ConversationSnapshot,
  OperationSnapshot,
} from "@stackbridge/protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { ApprovedCommandRequest, CommandBlock } from "./terminal-session.js";
import { WorkspaceStore } from "./workspace-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WorkspaceStore", () => {
  it("persists the selected interface language outside the browser origin", () => {
    const directory = temporaryDirectory();
    const first = new WorkspaceStore(directory);
    expect(first.loadLocale()).toBe("en");
    first.saveLocale("zh-CN");
    first.close();

    const reopened = new WorkspaceStore(directory);
    expect(reopened.loadLocale()).toBe("zh-CN");
    reopened.saveLocale("en");
    expect(reopened.loadLocale()).toBe("en");
    reopened.close();
  });

  it("restores conversations, frozen proposals, durable operations, and command output", () => {
    const directory = temporaryDirectory();
    const conversation = sampleConversation();
    const proposal = conversation.proposals[0]!;
    const scope = sampleScope(proposal);
    const operation = sampleOperation(proposal);
    const command = sampleCommand();

    const first = new WorkspaceStore(directory);
    first.saveConversation(conversation);
    first.reserveOperation(proposal, scope, operation);
    first.recordCommand(command);
    first.close();

    const reopened = new WorkspaceStore(directory);
    expect(reopened.loadConversations()).toEqual([conversation]);
    expect(reopened.loadProposals()).toEqual([{ proposal, scope }]);
    expect(reopened.loadOperations()).toEqual([operation]);
    expect(reopened.readCommand(command.id)).toEqual(command);
    reopened.close();
  });

  it("retains command metadata when the configured output budget removes the chunk", () => {
    const directory = temporaryDirectory();
    const command = sampleCommand();
    const store = new WorkspaceStore(directory, { outputLimitBytes: 4 });

    store.recordCommand(command);

    expect(store.readCommand(command.id)).toEqual({
      ...command,
      output: "",
      outputTruncated: true,
    });
    store.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "stackbridge-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sampleOperation(proposal: CommandProposal): OperationSnapshot {
  return {
    schemaVersion: 2,
    id: "00000000-0000-4000-8000-000000000007",
    proposalId: proposal.id,
    status: "accepted",
    command: proposal.command,
    createdAt: "2026-09-18T00:00:02.000Z",
    updatedAt: "2026-09-18T00:00:02.000Z",
  };
}

function sampleConversation(): ConversationSnapshot {
  const proposal: CommandProposal = {
    schemaVersion: 2,
    id: "00000000-0000-4000-8000-000000000003",
    conversationId: "00000000-0000-4000-8000-000000000001",
    agentSessionId: "00000000-0000-4000-8000-000000000004",
    terminalSessionId: "00000000-0000-4000-8000-000000000002",
    environmentFrameId: "env.test",
    environmentKind: "docker",
    environmentLabel: "Docker: test",
    bindingId: "binding.test",
    purpose: "显示目录",
    command: "pwd",
    cwd: "/workspace",
    shell: "bash",
    user: "root",
    createdAt: "2026-09-18T00:00:00.000Z",
    expiresAt: "2026-09-18T00:05:00.000Z",
    status: "pending",
  };
  return {
    schemaVersion: 2,
    id: proposal.conversationId,
    title: "测试会话",
    model: "gpt-5.6-sol",
    codexThreadId: "thread-test",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:01.000Z",
    messages: [{
      schemaVersion: 2,
      id: "00000000-0000-4000-8000-000000000005",
      role: "assistant",
      content: "可以执行 pwd。",
      createdAt: "2026-09-18T00:00:01.000Z",
      agentSessionId: proposal.agentSessionId,
      proposalIds: [proposal.id],
    }],
    proposals: [proposal],
  };
}

function sampleScope(proposal: CommandProposal): ApprovedCommandRequest {
  return {
    operationId: "",
    command: proposal.command,
    terminalSessionId: proposal.terminalSessionId,
    environmentFrameId: proposal.environmentFrameId,
    bindingId: proposal.bindingId,
    cwd: proposal.cwd,
    shell: proposal.shell,
    contextVersion: 3,
    inputVersion: 5,
  };
}

function sampleCommand(): CommandBlock {
  return {
    id: "00000000-0000-4000-8000-000000000006",
    terminalSessionId: "00000000-0000-4000-8000-000000000002",
    environmentFrameId: "env.test",
    bindingId: "binding.test",
    source: "manual",
    command: "printf hello",
    cwdBefore: "/workspace",
    cwdAfter: "/workspace",
    shell: "bash",
    user: "root",
    startedAt: "2026-09-18T00:00:02.000Z",
    endedAt: "2026-09-18T00:00:03.000Z",
    exitCode: 0,
    outputStartSequence: 10,
    outputEndSequence: 16,
    output: "hello\n",
    outputTruncated: false,
    captureQuality: "exact",
  };
}
