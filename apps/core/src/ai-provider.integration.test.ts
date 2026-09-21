import { createServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AiProviderService, type SecretProtector } from "./ai-provider-service.js";
import { ConversationService } from "./conversation-service.js";
import { createCoreServer, type CoreServer } from "./server.js";
import { TerminalSessionManager } from "./terminal-session.js";
import { ControlledPty } from "./test/controlled-pty.js";
import { WorkspaceStore } from "./workspace-store.js";

const origin = "http://127.0.0.1:5173";
const temporaryDirectories: string[] = [];

describe("AI provider HTTP boundary", () => {
  let core: CoreServer | undefined;
  let deepSeek: HttpServer | undefined;
  let workspace: WorkspaceStore | undefined;

  afterEach(async () => {
    await core?.close();
    if (deepSeek !== undefined) await closeServer(deepSeek);
    workspace?.close();
    workspace = undefined;
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("configures and tests DeepSeek without returning its API key", async () => {
    const requests: Array<{ authorization?: string; url?: string; body: unknown }> = [];
    deepSeek = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push({
          ...(request.url === undefined ? {} : { url: request.url }),
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          body: JSON.parse(body),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "response-test",
          status: "completed",
          output: [{
            type: "message",
            content: [{ type: "output_text", text: "{\"answer\":\"READY\",\"proposals\":[]}" }],
          }],
        }));
      });
    });
    const deepSeekUrl = await listenHttp(deepSeek);
    const directory = temporaryDirectory();
    workspace = new WorkspaceStore(directory);
    const ai = new AiProviderService({
      profiles: workspace,
      secretProtector: testSecretProtector,
      allowInsecureLoopback: true,
    });
    core = createCoreServer({
      allowedOrigins: [origin],
      terminalSessions: new TerminalSessionManager(() => new ControlledPty()),
      ai,
    });
    const baseUrl = await listenCore(core);
    const cookie = await authenticate(baseUrl);
    const headers = { origin, cookie, "content-type": "application/json" };

    const tested = await fetch(`${baseUrl}/v1/ai/providers/deepseek/test`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 2,
        baseUrl: deepSeekUrl,
        model: "deepseek-test",
        apiKey: "ds-secret",
      }),
    });
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({ ok: true, model: "deepseek-test" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/responses");
    expect(requests[0]?.authorization).toBe("Bearer ds-secret");
    expect(requests[0]?.body).toMatchObject({ model: "deepseek-test" });

    const saved = await fetch(`${baseUrl}/v1/ai/providers/deepseek`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        schemaVersion: 2,
        baseUrl: deepSeekUrl,
        model: "deepseek-test",
        apiKey: "ds-secret",
      }),
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.json())).not.toContain("ds-secret");

    const listed = await fetch(`${baseUrl}/v1/ai/providers`, { headers: { origin, cookie } });
    const listedText = await listed.text();
    expect(listed.status).toBe(200);
    expect(listedText).not.toContain("ds-secret");
    expect(JSON.parse(listedText)).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          id: "chatgpt",
          available: false,
          configured: false,
        }),
        expect.objectContaining({
          id: "deepseek",
          kind: "deepseek",
          configured: true,
          hasApiKey: true,
          model: "deepseek-test",
          lastVerifiedAt: expect.any(String),
        }),
      ]),
    });

    const models = await fetch(`${baseUrl}/v1/ai/models?providerId=deepseek`, {
      headers: { origin, cookie },
    });
    expect(await models.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ model: "deepseek-flash" }),
        expect.objectContaining({ model: "deepseek-v4-pro" }),
        expect.objectContaining({ model: "deepseek-test" }),
      ]),
    });

    const cleared = await fetch(`${baseUrl}/v1/ai/providers/deepseek`, {
      method: "DELETE",
      headers,
    });
    expect(cleared.status).toBe(204);
    const afterClear = await fetch(`${baseUrl}/v1/ai/providers`, {
      headers: { origin, cookie },
    });
    expect(await afterClear.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ id: "deepseek", configured: false, hasApiKey: false }),
      ]),
    });

  });

  it("rejects insecure provider URLs and recovers from an undecryptable saved key", async () => {
    workspace = new WorkspaceStore(temporaryDirectory());
    const recoveringProtector: SecretProtector = {
      persistence: "system-encrypted",
      protect(value) {
        return `protected:${value}`;
      },
      unprotect(value) {
        if (value === "undecryptable") throw new Error("Windows user changed");
        return value.replace(/^protected:/, "");
      },
    };
    workspace.saveDeepSeekProfile({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      protectedApiKey: "undecryptable",
      updatedAt: "2026-09-21T00:00:00.000Z",
    });
    const ai = new AiProviderService({ profiles: workspace, secretProtector: recoveringProtector });
    core = createCoreServer({
      allowedOrigins: [origin],
      terminalSessions: new TerminalSessionManager(() => new ControlledPty()),
      ai,
    });
    const baseUrl = await listenCore(core);
    const cookie = await authenticate(baseUrl);
    const headers = { origin, cookie, "content-type": "application/json" };

    const listed = await fetch(`${baseUrl}/v1/ai/providers`, { headers: { origin, cookie } });
    expect(await listed.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          id: "deepseek",
          configured: false,
          hasApiKey: false,
          error: expect.stringContaining("could not be decrypted"),
        }),
      ]),
    });

    const insecure = await fetch(`${baseUrl}/v1/ai/providers/deepseek`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        schemaVersion: 2,
        baseUrl: "http://127.0.0.1:9000",
        model: "deepseek-test",
        apiKey: "replacement-secret",
      }),
    });
    expect(insecure.status).toBe(400);
    expect(await insecure.json()).toMatchObject({ error: "invalid_deepseek_configuration" });

    const recovered = await fetch(`${baseUrl}/v1/ai/providers/deepseek`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        schemaVersion: 2,
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-flash",
        apiKey: "replacement-secret",
      }),
    });
    const recoveredText = await recovered.text();
    expect(recovered.status).toBe(200);
    expect(recoveredText).not.toContain("replacement-secret");
    expect(JSON.parse(recoveredText)).toMatchObject({ configured: true, hasApiKey: true });
  });

  it("locks a conversation to DeepSeek and routes every turn through Responses API", async () => {
    const requestBodies: unknown[] = [];
    deepSeek = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requestBodies.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: `response-${requestBodies.length}`,
          status: "completed",
          output: [{
            type: "message",
            content: [{
              type: "output_text",
              text: JSON.stringify({
                answer: `DeepSeek answer ${requestBodies.length}: ${"A".repeat(32_690)}`,
                proposals: [{ purpose: "Show location", command: "Get-Location" }],
              }),
            }],
          }],
        }));
      });
    });
    const deepSeekUrl = await listenHttp(deepSeek);
    workspace = new WorkspaceStore(temporaryDirectory());
    const ai = new AiProviderService({
      profiles: workspace,
      secretProtector: testSecretProtector,
      allowInsecureLoopback: true,
    });
    ai.configureDeepSeek({
      schemaVersion: 2,
      baseUrl: deepSeekUrl,
      model: "deepseek-test",
      apiKey: "route-secret",
    });
    const terminals = new TerminalSessionManager(() => new ControlledPty());
    const conversations = new ConversationService(terminals, ai);
    core = createCoreServer({
      allowedOrigins: [origin],
      terminalSessions: terminals,
      conversations,
      ai,
    });
    const baseUrl = await listenCore(core);
    const cookie = await authenticate(baseUrl);
    const headers = { origin, cookie, "content-type": "application/json" };
    const terminalResponse = await fetch(`${baseUrl}/v1/terminal-sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cols: 100, rows: 30 }),
    });
    const terminal = await terminalResponse.json() as { id: string };

    const createdResponse = await fetch(`${baseUrl}/v1/conversations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 2,
        terminalSessionId: terminal.id,
        providerId: "deepseek",
        model: "deepseek-test",
      }),
    });
    const created = await createdResponse.json() as { id: string; providerId: string; model: string };
    expect(createdResponse.status).toBe(201);
    expect(created).toMatchObject({ providerId: "deepseek", model: "deepseek-test" });

    for (const message of ["Where am I?", "And now?", "One more time?"]) {
      const turn = await fetch(`${baseUrl}/v1/conversations/${created.id}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({ schemaVersion: 2, terminalSessionId: terminal.id, message }),
      });
      expect(turn.status).toBe(200);
      expect(await turn.json()).toMatchObject({
        providerId: "deepseek",
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "assistant", content: expect.stringContaining("DeepSeek answer") }),
        ]),
        proposals: expect.arrayContaining([
          expect.objectContaining({ command: "Get-Location" }),
        ]),
      });
    }

    expect(requestBodies).toHaveLength(3);
    expect(JSON.stringify(requestBodies[1])).toContain("DeepSeek answer 1");
    expect(JSON.stringify(requestBodies[1])).toContain("And now?");
    const thirdInput = deepSeekInputText(requestBodies[2]);
    expect(Buffer.byteLength(taggedBlock(thirdInput, "conversation_history"), "utf8"))
      .toBeLessThanOrEqual(64 * 1_024);
    expect(Buffer.byteLength(taggedBlock(thirdInput, "terminal_context"), "utf8"))
      .toBeLessThanOrEqual(64 * 1_024);
  });

  it("cancels an active DeepSeek turn through the conversation stop endpoint", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    deepSeek = createServer((request) => {
      request.resume();
      request.once("end", requestStarted);
    });
    const deepSeekUrl = await listenHttp(deepSeek);
    workspace = new WorkspaceStore(temporaryDirectory());
    const ai = new AiProviderService({
      profiles: workspace,
      secretProtector: testSecretProtector,
      allowInsecureLoopback: true,
    });
    ai.configureDeepSeek({
      schemaVersion: 2,
      baseUrl: deepSeekUrl,
      model: "deepseek-test",
      apiKey: "cancel-secret",
    });
    const terminals = new TerminalSessionManager(() => new ControlledPty());
    const conversations = new ConversationService(terminals, ai);
    core = createCoreServer({
      allowedOrigins: [origin],
      terminalSessions: terminals,
      conversations,
      ai,
    });
    const baseUrl = await listenCore(core);
    const cookie = await authenticate(baseUrl);
    const headers = { origin, cookie, "content-type": "application/json" };
    const terminalResponse = await fetch(`${baseUrl}/v1/terminal-sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cols: 100, rows: 30 }),
    });
    const terminal = await terminalResponse.json() as { id: string };
    const createdResponse = await fetch(`${baseUrl}/v1/conversations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 2,
        terminalSessionId: terminal.id,
        providerId: "deepseek",
        model: "deepseek-test",
      }),
    });
    const conversation = await createdResponse.json() as { id: string };

    const turn = fetch(`${baseUrl}/v1/conversations/${conversation.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 2,
        terminalSessionId: terminal.id,
        message: "Wait for this request",
      }),
    });
    await started;
    const stopped = await fetch(`${baseUrl}/v1/conversations/${conversation.id}/stop`, {
      method: "POST",
      headers,
    });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ stopped: true });

    const cancelled = await turn;
    expect(cancelled.status).toBe(408);
    expect(await cancelled.json()).toMatchObject({ error: "deepseek_request_cancelled" });
  });

  it("returns stable errors for authentication, throttling, timeout, server failure, and malformed responses", async () => {
    deepSeek = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const model = (JSON.parse(body) as { model: string }).model;
        if (model === "unauthorized") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end('{"error":"invalid key"}');
          return;
        }
        if (model === "limited") {
          response.writeHead(429, { "content-type": "application/json" });
          response.end('{"error":"slow down"}');
          return;
        }
        if (model === "timeout") return;
        if (model === "server-error") {
          response.writeHead(503, { "content-type": "application/json" });
          response.end('{"error":"unavailable"}');
          return;
        }
        if (model === "oversized-answer" || model === "oversized-wire-response") {
          const answerSize = model === "oversized-answer" ? 256 * 1_024 + 1 : 1_024 * 1_024 + 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            output_text: JSON.stringify({ answer: "X".repeat(answerSize), proposals: [] }),
          }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"completed","output":[]}');
      });
    });
    const deepSeekUrl = await listenHttp(deepSeek);
    workspace = new WorkspaceStore(temporaryDirectory());
    const ai = new AiProviderService({
      profiles: workspace,
      secretProtector: testSecretProtector,
      allowInsecureLoopback: true,
      requestTimeoutMs: 50,
    });
    core = createCoreServer({
      allowedOrigins: [origin],
      terminalSessions: new TerminalSessionManager(() => new ControlledPty()),
      ai,
    });
    const baseUrl = await listenCore(core);
    const cookie = await authenticate(baseUrl);
    const headers = { origin, cookie, "content-type": "application/json" };

    for (const expected of [
      { model: "unauthorized", status: 401, error: "deepseek_authentication_failed" },
      { model: "limited", status: 429, error: "deepseek_rate_limited" },
      { model: "timeout", status: 408, error: "deepseek_request_timeout" },
      { model: "server-error", status: 502, error: "deepseek_request_failed" },
      { model: "oversized-answer", status: 502, error: "deepseek_invalid_response" },
      { model: "oversized-wire-response", status: 502, error: "deepseek_invalid_response" },
      { model: "malformed", status: 502, error: "deepseek_invalid_response" },
    ]) {
      const response = await fetch(`${baseUrl}/v1/ai/providers/deepseek/test`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 2,
          baseUrl: deepSeekUrl,
          model: expected.model,
          apiKey: "never-return-this-key",
        }),
      });
      const text = await response.text();
      expect(response.status).toBe(expected.status);
      expect(JSON.parse(text)).toMatchObject({ error: expected.error });
      expect(text).not.toContain("never-return-this-key");
    }
  });
});

const testSecretProtector: SecretProtector = {
  persistence: "system-encrypted",
  protect(value) {
    return Buffer.from(value, "utf8").toString("base64");
  },
  unprotect(value) {
    return Buffer.from(value, "base64").toString("utf8");
  },
};

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "stackbridge-ai-provider-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function authenticate(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/auth/session`, {
    method: "POST",
    headers: { origin },
  });
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

async function listenCore(core: CoreServer): Promise<string> {
  await core.listen({ host: "127.0.0.1", port: 0 });
  const address = core.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function listenHttp(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function deepSeekInputText(body: unknown): string {
  const messages = (body as {
    input: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
  }).input;
  return messages.find((message) => message.role === "user")!.content[0]!.text;
}

function taggedBlock(input: string, tag: string): string {
  const match = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(input);
  if (match?.[1] === undefined) throw new Error(`Missing ${tag} block`);
  return match[1];
}
