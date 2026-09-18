import { describe, expect, it } from "vitest";

import { codexAppServerArguments } from "./codex-app-server.js";

describe("Codex App Server launch configuration", () => {
  it("stores ChatGPT credentials in StackBridge's isolated CODEX_HOME file", () => {
    expect(codexAppServerArguments()).toContain('cli_auth_credentials_store="file"');
    expect(codexAppServerArguments()).not.toContain('cli_auth_credentials_store="keyring"');
  });
});
