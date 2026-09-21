import { describe, expect, it, vi } from "vitest";

import {
  detectCodexCli,
  requireCodexCli,
  resolveCodexCli,
  resolveCodexCliCandidates,
  type CodexCommandProbe,
  type CodexLaunchDescriptor,
} from "./codex-cli.js";

const directCodex: CodexLaunchDescriptor = {
  command: "C:\\Tools\\codex.exe",
  argumentPrefix: [],
  resolvedPath: "C:\\Tools\\codex.exe",
};

describe("requireCodexCli", () => {
  it("keeps desktop startup available when Codex cannot be discovered", async () => {
    const detected = await detectCodexCli(
      () => { throw new Error("Codex CLI was not found in PATH"); },
      vi.fn<CodexCommandProbe>(),
    );

    expect(detected).toEqual({
      available: false,
      error: "Codex CLI was not found in PATH",
    });
  });

  it("accepts an installed Codex CLI and returns its verified version", async () => {
    const probe = vi.fn<CodexCommandProbe>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "codex-cli 0.155.0\r\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "Run the app server", stderr: "" });

    await expect(requireCodexCli(directCodex, probe)).resolves.toEqual({
      ...directCodex,
      version: "codex-cli 0.155.0",
    });
    expect(probe).toHaveBeenNthCalledWith(1, directCodex, ["--version"]);
    expect(probe).toHaveBeenNthCalledWith(2, directCodex, ["app-server", "--help"]);
  });

  it("rejects startup when Codex CLI cannot be executed", async () => {
    const probe = vi.fn<CodexCommandProbe>().mockRejectedValue(
      Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
    );

    await expect(requireCodexCli(directCodex, probe)).rejects.toThrow(
      "Codex CLI was not found",
    );
  });

  it("rejects startup when the version probe fails", async () => {
    const probe = vi.fn<CodexCommandProbe>().mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "failed to start",
    });

    await expect(requireCodexCli(directCodex, probe)).rejects.toThrow(
      "codex --version failed (exit 1): failed to start",
    );
  });

  it("rejects a CLI older than the compatible App Server baseline", async () => {
    const probe = vi.fn<CodexCommandProbe>().mockResolvedValue({
      exitCode: 0,
      stdout: "codex-cli 0.154.9",
      stderr: "",
    });

    await expect(requireCodexCli(directCodex, probe)).rejects.toThrow(
      "Codex CLI 0.155.0 or newer is required",
    );
  });

  it("selects the newest compatible CLI instead of an older PATH entry", async () => {
    const oldCodex = { ...directCodex, resolvedPath: "C:\\old\\codex.cmd" };
    const currentCodex = { ...directCodex, resolvedPath: "C:\\new\\codex.exe" };
    const probe = vi.fn<CodexCommandProbe>(async (launch, arguments_) => {
      if (arguments_[0] === "--version") {
        return {
          exitCode: 0,
          stdout: launch === oldCodex ? "codex-cli 0.128.0" : "codex-cli 0.155.0",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "Run the app server", stderr: "" };
    });

    await expect(requireCodexCli([oldCodex, currentCodex], probe)).resolves.toEqual({
      ...currentCodex,
      version: "codex-cli 0.155.0",
    });
    expect(probe).toHaveBeenCalledWith(currentCodex, ["app-server", "--help"]);
    expect(probe).not.toHaveBeenCalledWith(oldCodex, ["app-server", "--help"]);
  });

  it("orders full prerelease versions and prefers a stable release", async () => {
    const alphaTwo = { ...directCodex, resolvedPath: "C:\\alpha-two\\codex.exe" };
    const alphaThree = { ...directCodex, resolvedPath: "C:\\alpha-three\\codex.exe" };
    const stable = { ...directCodex, resolvedPath: "C:\\stable\\codex.exe" };
    const versions = new Map([
      [alphaTwo, "codex-cli 0.155.0-alpha.2.6"],
      [alphaThree, "codex-cli 0.155.0-alpha.3"],
      [stable, "codex-cli 0.155.0"],
    ]);
    const probe = vi.fn<CodexCommandProbe>(async (launch, arguments_) => ({
      exitCode: 0,
      stdout: arguments_[0] === "--version" ? versions.get(launch)! : "Run the app server",
      stderr: "",
    }));

    await expect(requireCodexCli([alphaTwo, alphaThree, stable], probe)).resolves.toEqual({
      ...stable,
      version: "codex-cli 0.155.0",
    });
  });

  it("resolves an npm .cmd shim to one stable Windows launch descriptor", () => {
    const nativeCodex = "C:\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe";
    const launch = resolveCodexCli({
      platform: "win32",
      path: "C:\\npm;C:\\desktop",
      pathExt: ".COM;.EXE;.BAT;.CMD",
      arch: "x64",
      isFile: (candidate) => candidate === "C:\\npm\\codex.cmd"
        || candidate === nativeCodex
        || candidate === "C:\\desktop\\codex.exe",
    });

    expect(launch).toEqual({
      command: nativeCodex,
      argumentPrefix: [],
      resolvedPath: nativeCodex,
    });
  });

  it("discovers every Windows PATH candidate for compatibility selection", () => {
    const nativeCodex = "C:\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe";
    const launches = resolveCodexCliCandidates({
      platform: "win32",
      path: "C:\\npm;C:\\desktop",
      pathExt: ".EXE;.CMD",
      arch: "x64",
      isFile: (candidate) => candidate === "C:\\npm\\codex.cmd"
        || candidate === nativeCodex
        || candidate === "C:\\desktop\\codex.exe",
    });

    expect(launches.map((launch) => launch.resolvedPath)).toEqual([
      nativeCodex,
      "C:\\desktop\\codex.exe",
    ]);
  });
});
