import { defineConfig } from "tsup";

const external = ["electron", "node-pty", "node:sqlite", "ws", "zod"];

export default defineConfig([
  {
    entry: {
      main: "src/main.ts",
      core: "../core/src/main.ts",
    },
    format: ["esm"],
    platform: "node",
    target: "node22",
    sourcemap: true,
    clean: true,
    external,
    noExternal: ["@stackbridge/protocol"],
  },
  {
    entry: { preload: "src/preload.ts" },
    format: ["cjs"],
    outExtension: () => ({ js: ".cjs" }),
    platform: "node",
    target: "node22",
    sourcemap: true,
    clean: false,
    external,
  },
]);
