import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // Vitest's default spec-glob would swallow the Playwright suite (e2e/).
    // .next/standalone holds a full copy of the tree from `next build` —
    // running those stale duplicates fails on missing env and double-counts.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "e2e/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
});
