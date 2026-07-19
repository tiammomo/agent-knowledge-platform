import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const coreOrigin = process.env.AKEP_CORE_ORIGIN ?? "http://127.0.0.1:38085";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 33005,
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
