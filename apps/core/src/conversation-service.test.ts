import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConversationService, type TerminalAssistant } from "./conversation-service.js";
import { TerminalSessionManager } from "./terminal-session.js";
import { ControlledPty } from "./test/controlled-pty.js";
import { WorkspaceStore } from "./workspace-store.js";

const testIntegrationToken = "test-shell-integration-token";
const testManagerOptions = {
  shellIntegrationTokenFactory: () => testIntegrationToken,
};

describe("conversation and approval workflow", () => {
  it("uses Luna for a new conversation when no model is selected", async () => {
    const pty = new ControlledPty();
    const terminals = new TerminalSessionManager(() => pty, testManagerOptions);
    const terminal = terminals.create({ cols: 100, rows: 30 });
    const assistant = new FakeAssistant();
    const conversations = new ConversationService(terminals, assistant);

    const conversation = await conversations.create({
      schemaVersion: 2,
      terminalSessionId: terminal.id,
    });

    expect(conversation.model).toBe("gpt-5.6-luna");
    expect(assistant.lastCreateModel).toBe("gpt-5.6-luna");
  });

  it("freezes terminal context for a turn and turns model output into a Core-owned proposal", async () => {
    const pty = new ControlledPty();
    const terminals = new TerminalSessionManager(() => pty, testManagerOptions);
    const terminal = terminals.create({ cols: 100, rows: 30 });
    pty.emitData(shellMarker({
      type: "prompt",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
    }));
    pty.emitData(shellMarker({
      type: "commandStart",
      command: "Get-Item missing",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
    }));
    pty.emitData("Cannot find path missing\r\n");
    pty.emitData(shellMarker({ type: "commandEnd", cwd: "C:\\work", exitCode: 1 }));
    pty.emitData(shellMarker({
      type: "prompt",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
    }));
    const assistant = new FakeAssistant();
    const conversations = new ConversationService(terminals, assistant);
    const conversation = await conversations.create({
      schemaVersion: 2,
      terminalSessionId: terminal.id,
      model: "gpt-test",
    });

    const result = await conversations.turn(conversation.id, {
      schemaVersion: 2,
      terminalSessionId: terminal.id,
      message: "这个错误是什么意思？",
    });

    expect(assistant.lastTurn).toMatchObject({
      providerSessionId: "thread-1",
      message: "这个错误是什么意思？",
      context: {
        terminalSessionId: terminal.id,
        environment: { kind: "local", verified: true },
        cwd: "C:\\work",
        shell: "powershell",
        recentCommands: [
          expect.objectContaining({
            command: "Get-Item missing",
            exitCode: 1,
            output: "Cannot find path missing\r\n",
          }),
        ],
      },
    });
    expect(result.proposals).toEqual([
      expect.objectContaining({
        command: "Get-ChildItem",
        purpose: "查看当前目录",
        terminalSessionId: terminal.id,
        environmentFrameId: terminal.context().environment.id,
        cwd: "C:\\work",
        shell: "powershell",
        status: "pending",
      }),
    ]);
  });

  it("includes the current foreground command output snapshot without waiting for it to finish", async () => {
    const pty = new ControlledPty();
    const terminals = new TerminalSessionManager(() => pty, testManagerOptions);
    const terminal = terminals.create({ cols: 100, rows: 30 });
    pty.emitData(shellMarker({
      type: "prompt",
      cwd: "/workspace",
      shell: "bash",
      user: "root",
    }));
    pty.emitData(shellMarker({
      type: "commandStart",
      command: "python app.py",
      cwd: "/workspace",
      shell: "bash",
      user: "root",
    }));
    pty.emitData("starting server\r\nerror: address already in use\r\n");
    const assistant = new FakeAssistant();
    const conversations = new ConversationService(terminals, assistant);
    const conversation = await conversations.create({
      schemaVersion: 2,
      terminalSessionId: terminal.id,
      model: "gpt-test",
    });

    await conversations.turn(conversation.id, {
      schemaVersion: 2,
      terminalSessionId: terminal.id,
      message: "现在的输出是什么意思？",
    });

    expect(assistant.lastTurn).toMatchObject({
      context: {
        shellState: "running",
        recentCommands: [expect.objectContaining({
          command: "python app.py",
          output: "starting server\r\nerror: address already in use\r\n",
          captureQuality: "screen",
        })],
      },
    });
  });

  it("keeps one conversation while recording terminal environment changes on its timeline", async () => {
    const localPty = new ControlledPty();
    const dockerPty = new ControlledPty();
    const terminals = new TerminalSessionManager(() => localPty, testManagerOptions);
    const local = terminals.create({ cols: 100, rows: 30 });
    const docker = terminals.createFromPty(
      { cols: 100, rows: 30 },
      dockerPty,
      {
        environments: [
          { id: "env.local", kind: "local", label: "Local Windows", verified: true, bindingId: "local" },
          { id: "env.ssh", parentId: "env.local", kind: "ssh", label: "friden@cube", verified: true, bindingId: "host" },
          { id: "env.docker", parentId: "env.ssh", kind: "docker", label: "Docker: ubuntu22", verified: true, bindingId: "container" },
        ],
        cwd: "/workspace",
        shell: "bash",
        user: "root",
        shellState: "idle",
      },
    );
    localPty.emitData(shellMarker({
      type: "prompt",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
    }));
    const conversations = new ConversationService(terminals, new FakeAssistant());
    const conversation = await conversations.create({ schemaVersion: 2, terminalSessionId: local.id, model: "gpt-test" });

    await conversations.turn(conversation.id, { schemaVersion: 2, terminalSessionId: local.id, message: "我在哪？" });
    const switched = await conversations.turn(conversation.id, {
      schemaVersion: 2,
      terminalSessionId: docker.id,
      message: "现在呢？",
    });

    expect(switched.messages.filter((message) => message.role === "timeline").map((message) => message.content)).toEqual([
      "当前环境：Local Windows",
      "切换到：Local Windows → friden@cube → Docker: ubuntu22",
    ]);
  });

  it("executes an accepted proposal once and refuses it after the frozen scope changes", async () => {
    const pty = new ControlledPty();
    const terminals = new TerminalSessionManager(() => pty, testManagerOptions);
    const terminal = terminals.create({ cols: 100, rows: 30 });
    pty.emitData(shellMarker({
      type: "prompt",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
    }));
    const conversations = new ConversationService(terminals, new FakeAssistant());
    const conversation = await conversations.create({
      schemaVersion: 2,
      terminalSessionId: terminal.id,
      model: "gpt-test",
    });
    const firstTurn = await conversations.turn(conversation.id, {
      schemaVersion: 2,
      terminalSessionId: terminal.id,
      message: "列出目录",
    });
    const proposal = firstTurn.proposals[0]!;

    const accepted = conversations.decide(proposal.id, "execute");
    const repeated = conversations.decide(proposal.id, "execute");

    expect(accepted.operation).toMatchObject({ status: "accepted" });
    expect(repeated.operation?.id).toBe(accepted.operation?.id);
    expect(pty.writes).toEqual(["Get-ChildItem\r"]);

    pty.emitData(shellMarker({
      type: "commandStart",
      command: "Get-ChildItem",
      cwd: "C:\\work",
      shell: "powershell",
      user: "zplea",
    }));
    pty.emitData("file.txt\r\n");
    pty.emitData(shellMarker({ type: "commandEnd", cwd: "C:\\work", exitCode: 0 }));
    expect(conversations.operation(accepted.operation!.id)).toMatchObject({
      proposalId: proposal.id,
      status: "completed",
      exitCode: 0,
    });

    pty.emitData(shellMarker({
      type: "prompt",
      cwd: "C:\\other",
      shell: "powershell",
      user: "zplea",
    }));
    const secondTurn = await conversations.turn(conversation.id, {
      schemaVersion: 2,
      terminalSessionId: terminal.id,
      message: "再列一次",
    });
    const stale = secondTurn.proposals.at(-1)!;
    terminal.write("manual text");
    expect(() => conversations.decide(stale.id, "execute")).toThrow(
      "Terminal context changed; confirm the command again",
    );
    expect(conversations.snapshot(conversation.id).proposals.at(-1)).toMatchObject({
      id: stale.id,
      status: "stale",
    });
  });

  it("restores the continuous conversation and frozen proposals from SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stackbridge-conversation-"));
    try {
      const pty = new ControlledPty();
      const terminals = new TerminalSessionManager(() => pty, testManagerOptions);
      const terminal = terminals.create({ cols: 100, rows: 30 });
      pty.emitData(shellMarker({
        type: "prompt",
        cwd: "/workspace",
        shell: "bash",
        user: "root",
      }));
      const firstStore = new WorkspaceStore(directory);
      const first = new ConversationService(
        terminals,
        new FakeAssistant(),
        () => new Date("2026-09-18T00:00:00.000Z"),
        firstStore,
      );
      const created = await first.create({ schemaVersion: 2, terminalSessionId: terminal.id, model: "gpt-test" });
      const completed = await first.turn(created.id, {
        schemaVersion: 2,
        terminalSessionId: terminal.id,
        message: "列出目录",
      });
      firstStore.close();

      const reopenedStore = new WorkspaceStore(directory);
      const restored = new ConversationService(terminals, new FakeAssistant(), undefined, reopenedStore);

      expect(restored.list()).toEqual([completed]);
      expect(restored.snapshot(created.id).proposals[0]).toMatchObject({
        command: "Get-ChildItem",
        status: "pending",
      });
      reopenedStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores an accepted operation as unknown and never resubmits it after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stackbridge-operation-"));
    try {
      const firstPty = new ControlledPty();
      const firstTerminals = new TerminalSessionManager(() => firstPty, testManagerOptions);
      const terminal = firstTerminals.create({ cols: 100, rows: 30 });
      firstPty.emitData(shellMarker({
        type: "prompt",
        cwd: "C:\\work",
        shell: "powershell",
        user: "zplea",
      }));
      const firstStore = new WorkspaceStore(directory);
      const first = new ConversationService(firstTerminals, new FakeAssistant(), undefined, firstStore);
      const conversation = await first.create({
        schemaVersion: 2,
        terminalSessionId: terminal.id,
        model: "gpt-test",
      });
      const turn = await first.turn(conversation.id, {
        schemaVersion: 2,
        terminalSessionId: terminal.id,
        message: "列出目录",
      });
      const accepted = first.decide(turn.proposals[0]!.id, "execute");
      firstStore.close();

      const secondPty = new ControlledPty();
      const secondTerminals = new TerminalSessionManager(() => secondPty, testManagerOptions);
      const reopenedStore = new WorkspaceStore(directory);
      const restored = new ConversationService(
        secondTerminals,
        new FakeAssistant(),
        undefined,
        reopenedStore,
      );

      expect(restored.operation(accepted.operation!.id)).toMatchObject({
        id: accepted.operation!.id,
        status: "unknown",
      });
      expect(restored.decide(turn.proposals[0]!.id, "execute").operation).toMatchObject({
        id: accepted.operation!.id,
        status: "unknown",
      });
      expect(secondPty.writes).toEqual([]);
      reopenedStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

class FakeAssistant implements TerminalAssistant {
  lastCreateModel: string | undefined;
  lastTurn: unknown;

  async startSession(model: string): Promise<string> {
    this.lastCreateModel = model;
    return "thread-1";
  }

  async runTurn(input: Parameters<TerminalAssistant["runTurn"]>[0]) {
    this.lastTurn = input;
    return {
      answer: "路径不存在。可以先查看当前目录。",
      proposals: [{ purpose: "查看当前目录", command: "Get-ChildItem" }],
    };
  }
}

function shellMarker(event: object): string {
  const payload = Buffer.from(JSON.stringify(event), "utf8").toString("base64url");
  return `\u001b]777;stackbridge;${testIntegrationToken};${payload}\u0007`;
}
