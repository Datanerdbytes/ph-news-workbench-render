import type { Page } from "@playwright/test";
import { requireEnv } from "./env";

/**
 * Re-establish the owner session in this test's browser context. The shell
 * suite signs out of the shared storage-state session, which deletes the
 * session row server-side — every spec that runs after it (alphabetical
 * order) needs its own fresh sign-in before its authenticated fetches.
 * `page.request` shares the cookie jar with the page context, so the fresh
 * session cookie authenticates the page's API calls.
 */
export async function ensureOwnerSession(
  page: Page,
  origin: string,
): Promise<void> {
  const response = await page.request.post("/api/auth/sign-in/email", {
    headers: { origin },
    data: {
      email: requireEnv("OWNER_EMAIL"),
      password: requireEnv("OWNER_PASSWORD"),
    },
  });
  if (!response.ok()) {
    throw new Error("Could not re-establish the owner session for this test");
  }
}
