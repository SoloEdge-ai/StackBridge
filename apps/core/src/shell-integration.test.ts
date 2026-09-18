import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bashIntegrationScript,
  ensurePowerShellIntegration,
  powerShellIntegrationScript,
  zshIntegrationScript,
} from "./shell-integration.js";

describe("session-only shell integration", () => {
  it("bootstraps the current token into a hand-typed interactive SSH session", () => {
    const script = powerShellIntegrationScript();

    expect(script).toContain("Install-StackBridgeRemoteShellIntegration");
    expect(script).toContain("$interactiveArgs = @('-tt') + $sshArgs");
    expect(script).toContain("$HOME/.sbridge/shell/bashrc");
    expect(script).toContain("$HOME/.sbridge/shell/.zshrc");
    expect(script).toContain("exec zsh -i");
    expect(script).toContain("$([char]0x256D)$([char]0x2500)[ $script:StackBridgeContext ]");
    expect(script).toContain("STACKBRIDGE_CONTEXT_B64");
  });

  it.each([
    ["bash", bashIntegrationScript("test-token")],
    ["zsh", zshIntegrationScript("test-token")],
  ])("wraps interactive docker exec in %s", (_shell, script) => {
    expect(script).toContain("docker() {");
    expect(script).toContain("environmentPush");
    expect(script).toContain("Docker: $selector_json");
    expect(script).toContain("command docker");
    expect(script).toContain("environmentPop");
    expect(script).toContain("__sb_print_context");
    expect(script).toContain("╭─[ %s ]");
  });

  it("writes private remote shell templates beside the PowerShell integration", () => {
    const directory = mkdtempSync(join(tmpdir(), "stackbridge-shell-integration-"));
    try {
      const integrationPath = ensurePowerShellIntegration(directory);
      const shellDirectory = join(directory, "shell");

      expect(readFileSync(integrationPath, "utf8")).toContain(
        "Install-StackBridgeRemoteShellIntegration",
      );
      expect(readFileSync(join(shellDirectory, "bashrc.template"), "utf8")).toContain(
        "__STACKBRIDGE_SESSION_TOKEN__",
      );
      expect(readFileSync(join(shellDirectory, "zshrc.template"), "utf8")).toContain(
        "__STACKBRIDGE_SESSION_TOKEN__",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
