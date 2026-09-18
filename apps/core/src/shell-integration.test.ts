import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bashDockerPromptScript,
  bashIntegrationScript,
  ensurePowerShellIntegration,
  powerShellIntegrationScript,
  remoteTerminalEnvironmentBootstrap,
  zshDockerPromptScript,
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
    expect(script).toContain("for __sb_locale in C.UTF-8 C.utf8 en_US.UTF-8 en_US.utf8");
  });

  it("selects an available UTF-8 locale for managed remote shells", () => {
    expect(remoteTerminalEnvironmentBootstrap).toContain('LC_ALL="$__sb_locale" locale charmap');
    expect(remoteTerminalEnvironmentBootstrap).toContain('export LANG="$__sb_locale" LC_ALL="$__sb_locale"');
    expect(remoteTerminalEnvironmentBootstrap).toContain("export TERM=xterm-256color");
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
    expect(script).toContain("STACKBRIDGE_PROMPT_B64");
    expect(script).toContain("STACKBRIDGE_CONTEXT_B64=$context_encoded");
    expect(script).toContain("mktemp -d");
    expect(script).toContain("STACKBRIDGE_TARGET_SHELL");
  });

  it("bootstraps session-only integration into a hand-typed local Docker shell", () => {
    const script = powerShellIntegrationScript();

    expect(script).toContain("STACKBRIDGE_PROMPT_B64=");
    expect(script).toContain("STACKBRIDGE_CONTEXT_B64=");
    expect(script).toContain("mktemp -d");
    expect(script).toContain("STACKBRIDGE_TARGET_SHELL=");
  });

  it.each([
    ["bash", bashDockerPromptScript("docker-test-token")],
    ["zsh", zshDockerPromptScript("docker-test-token")],
  ])("keeps the Docker %s integration command-scoped", (_shell, script) => {
    expect(script).toContain("command-scoped Docker");
    expect(script).toContain("STACKBRIDGE_CONTEXT_B64");
    expect(script).toContain("STACKBRIDGE_EPHEMERAL_DIR");
    expect(script).toContain("docker-test-token");
    expect(script).toContain("commandStart");
    expect(script).toContain("commandEnd");
    expect(script).not.toContain("environmentPush");
    expect(script).not.toContain("environmentPop");
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
      const dockerBash = readFileSync(join(shellDirectory, "docker-bashrc.template"), "utf8");
      const dockerZsh = readFileSync(join(shellDirectory, "docker-zshrc.template"), "utf8");
      expect(dockerBash).toContain("command-scoped Docker Bash");
      expect(dockerZsh).toContain("command-scoped Docker Zsh");
      expect(dockerBash).toContain("__STACKBRIDGE_DOCKER_TOKEN__");
      expect(dockerZsh).toContain("__STACKBRIDGE_DOCKER_TOKEN__");
      expect(dockerBash).not.toContain("__STACKBRIDGE_SESSION_TOKEN__");
      expect(dockerZsh).not.toContain("__STACKBRIDGE_SESSION_TOKEN__");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
