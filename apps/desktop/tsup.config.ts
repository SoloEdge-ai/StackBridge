import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "src/main.ts",
    core: "../core/src/main.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  external: ["electron", "node-pty", "node:sqlite", "ws", "zod"],
  noExternal: ["@stackbridge/protocol"],
});
