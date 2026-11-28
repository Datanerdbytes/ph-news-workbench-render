import { expect, test } from "@playwright/test";

test("publishing keeps the schedule panel locked against cancellation", async ({ page }) => {
  const publishControl: { finish: () => void } = { finish: () => {} };
  const publishGate = new Promise<void>((resolve) => {
    publishControl.finish = resolve;
  });

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path === "/api/auth/get-session") {
      body = {
        user: { id: "u", name: "Owner", email: "owner@example.com" },
        session: { id: "s", userId: "u" },
      };
    } else if (path === "/api/items") {
      body = {
        rows: [{
          id: 101,
          title: "Schedule cancellation regression story",
          summary: "A local story used to verify publish locking.",
          link: "https://example.com/story",
          status: "drafted",
          draft_id: 501,
          feed_title: "Philippine Daily News",
        }],
        counts: { total: 1, pending: 0, drafted: 1, published: 0 },
        feedCounts: [],
      };
    } else if (path === "/api/drafts/501") {
      body = { text: "MANILA — A draft that remains locked while publishing." };
    } else if (path === "/api/facebook/status") {
      body = {
        configured: true,
        connected: true,
        page: { id: "page-1", name: "Philippine Daily News" },
        scopes: ["pages_manage_posts"],
      };
    } else if (path === "/api/facebook/pages") {
      body = { pages: [{ id: "page-1", name: "Philippine Daily News", primary: true }] };
    } else if (path === "/api/workspace") {
      body = { name: "Philippine Desk", role: "owner", memberCount: 1 };
    } else if (path === "/api/notifications") {
      body = { rows: [], unread: 0, hasMore: false };
    } else if (path === "/api/publish") {
      await publishGate;
      body = { page: { name: "Philippine Daily News" } };
    } else if (path.endsWith("/status")) {
      body = { configured: false, connected: false };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/compose");
  const draft = page.getByRole("textbox", { name: "Draft", exact: true });
  await expect(draft).toHaveValue(/MANILA/);
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByRole("group", { name: "Schedule post" })).toBeVisible();

  const publishRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/publish"
  );
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await publishRequest;

  await expect(page.getByRole("button", { name: "Schedule", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await expect(draft).toHaveAttribute("readonly", "");

  await page.getByRole("textbox", { name: "Publish date and time" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Schedule post" })).toBeVisible();
  await expect(draft).toHaveAttribute("readonly", "");

  publishControl.finish();
});
