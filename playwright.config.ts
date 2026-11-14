import { defineConfig } from "@playwright/test";
import { envLocal } from "./e2e/helpers/env";

// Sign-in only works from the origin auth trusts, so run on the port pinned by
// BETTER_AUTH_URL in .env.local instead of a hardcoded copy that can drift from
// the dev server (the source of INVALID_ORIGIN sign-in failures). When the
// developer's dev server is already up it is reused; otherwise one is booted.
// CI points the suite at the container under test instead, which already
// listens on its own port and must not be shadowed by a dev server.
const ciBaseURL = process.env.PLAYWRIGHT_BASE_URL;
// Env first, .env.local second — the same precedence e2e/helpers/env.ts
// requireEnv() uses, so CI's exported BETTER_AUTH_URL wins over a developer's
// local file.
const authURL = new URL(
  process.env.BETTER_AUTH_URL || envLocal().BETTER_AUTH_URL || "http://localhost:3000"
);
const PORT = Number(authURL.port) || 3000;
const baseURL = ciBaseURL ?? `http://localhost:${PORT}`;
const authFile = "e2e/.auth/owner.json";

export default defineConfig({
  testDir: "./e2e",
  // Regression suite: deterministic order beats speed. One worker keeps the
  // sign-out spec from killing the shared session mid-run for the others.
  fullyParallel: false,
  workers: 1,
  // Generous enough to absorb Turbopack cold-compile latency when the suite
  // runs against a freshly wiped .next (first hit of a page compiles it).
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "setup",
      testMatch: /setup\/.*\.ts/,
    },
    {
      name: "public",
      testMatch: /auth\.spec\.ts/,
    },
    {
      name: "authenticated",
      testIgnore: /auth\.spec\.ts|setup\//,
      dependencies: ["setup"],
      use: { storageState: authFile },
    },
  ],
  webServer: ciBaseURL
    ? undefined
    : {
        command: `npx next dev -p ${PORT}`,
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
        // The lockout spec sends six sign-ins in a row; better-auth's
        // production limiter answers 429 after three. A dev server that is
        // already running is reused as-is, so it has to be started with the
        // same flag (DISABLE_AUTH_RATE_LIMIT=1 npm run dev) for that spec to
        // reach the app's own lockout message.
        env: { DISABLE_AUTH_RATE_LIMIT: "1" },
      },
});
