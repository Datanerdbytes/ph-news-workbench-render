import { mkdirSync } from "node:fs";
import { test as setup, expect } from "@playwright/test";
import { requireEnv } from "../helpers/env";

const AUTH_DIR = "e2e/.auth";

setup("sign in as the seeded owner", async ({ request }, testInfo) => {
  // better-auth refuses a sign-in without an Origin header (MISSING_OR_NULL_
  // ORIGIN). The request context sends none, so the trusted origin is set by
  // hand — a browser would have done it on its own.
  const origin = new URL(
    testInfo.project.use.baseURL ?? "http://localhost:3000",
  ).origin;

  // Credentials come from .env.local (seed-owner.js account, pre-verified).
  const response = await request.post("/api/auth/sign-in/email", {
    headers: { origin },
    data: {
      email: requireEnv("OWNER_EMAIL"),
      password: requireEnv("OWNER_PASSWORD"),
    },
  });
  expect(response.ok()).toBeTruthy();

  mkdirSync(AUTH_DIR, { recursive: true });
  await request.storageState({ path: `${AUTH_DIR}/owner.json` });
});
