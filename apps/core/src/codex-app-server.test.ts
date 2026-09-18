import { describe, expect, it } from "vitest";

import { codexAppServerArguments, stableThreadStartParams, stableTurnStartParams } from "./codex-app-server.js";

describe("Codex App Server launch configuration", () => {
  it("stores ChatGPT credentials in StackBridge's isolated CODEX_HOME file", () => {
    expect(codexAppServerArguments()).toContain('cli_auth_credentials_store="file"');
    expect(codexAppServerArguments()).not.toContain('cli_auth_credentials_store="keyring"');
  });

  it("does not send experimental fields while the App Server experimental API is disabled", () => {
    const thread = stableThreadStartParams("gpt-5.6-luna", "C:/StackBridge/control");
    const turn = stableTurnStartParams("thread-1", "prompt", "gpt-5.6-luna");

    expect(thread).not.toHaveProperty("environments");
    expect(thread).not.toHaveProperty("dynamicTools");
    expect(thread).not.toHaveProperty("experimentalRawEvents");
    expect(turn).not.toHaveProperty("environments");
  });
});
