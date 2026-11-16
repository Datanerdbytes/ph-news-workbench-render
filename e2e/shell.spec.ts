import { expect, test } from "@playwright/test";

test("renders the dashboard activity feed", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Activity log" })
  ).toBeVisible();
  await expect(page.getByText("Loading your workspace…")).toBeHidden();
});

test("renders the dashboard publishing stats", async ({ page }) => {
  await page.goto("/dashboard");

  await expect(page.getByText("Total published")).toBeVisible();
  // The 30-day hint only renders when /api/analytics answered. A broken
  // platform query degrades the cards to a dash instead, so this is what
  // catches a query that no longer runs.
  await expect(page.getByText(/\d+ in the last 30 days/)).toBeVisible();
});

test("renders the calendar with its scheduled sidebar", async ({ page }) => {
  await page.goto("/calendar");
  await expect(page.getByRole("heading", { name: "Calendar", exact: true }))
    .toBeVisible();
  await expect(page.getByRole("heading", { name: "Scheduled" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Today" })).toBeVisible();
});

test("signs out from the account menu back to /login", async ({ page }) => {
  await page.goto("/dashboard");

  // The account trigger lives in the sidebar; the other aria-haspopup="dialog"
  // buttons (bell, publish nav, Facebook connection) are elsewhere in the frame.
  const trigger = page.locator("aside button[aria-haspopup='dialog']");
  // One trigger once the page has hydrated — the count waits out the
  // server-rendered copy the client render replaces.
  await expect(trigger).toHaveCount(1);
  await trigger.click();
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page).toHaveURL(/\/login/);
});
