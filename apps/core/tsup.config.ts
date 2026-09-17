import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  sourcemap: true,
  clean: true,
  external: ["node-pty"],
  noExternal: ["@stackbridge/protocol"],
});
