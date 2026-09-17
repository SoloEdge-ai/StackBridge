import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
  server: {
    host: "127.0.0.1",
    port: 5_173,
    strictPort: true,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:7331",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
