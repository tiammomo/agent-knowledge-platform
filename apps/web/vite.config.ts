import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const coreOrigin = process.env.AKEP_CORE_ORIGIN ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: Object.fromEntries(
      ["/.well-known", "/akep", "/console", "/health", "/schemas"].map((path) => [
        path,
        { changeOrigin: true, target: coreOrigin },
      ]),
    ),
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
