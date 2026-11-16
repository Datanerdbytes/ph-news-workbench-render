import { expect, test } from "@playwright/test";

test("renders the dashboard activity feed", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Activity log" })
  ).toBeVisible();
  await expect(page.getByText("Loading your workspace…")).toBeHidden();
});

test("renders the dashboard publishing stats", async ({ page }) => {
  // Wait for the stats the page actually renders, not the zero state it
  // paints before the response lands.
  const analyticsResponse = page.waitForResponse((response) =>
    response.url().includes("/api/analytics")
  );
  await page.goto("/dashboard");

  const res = await analyticsResponse;
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  const facebook = data.platforms.find(
    (entry: { platform: string }) => entry.platform === "facebook"
  );
  expect(facebook).toBeTruthy();

  const totalCard = page.locator("article").filter({ hasText: "Total published" });
  await expect(totalCard).toBeVisible();
  await expect(
    totalCard.getByText(String(facebook.published.total), { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(
      new RegExp(`${facebook.published30d.total} in the last 30 days`)
    )
  ).toBeVisible();

  // And the endpoint itself must answer with a platform breakdown — the
  // dashboard swallows a failed stats call on purpose, so only the
  // response catches a broken aggregation.
  const apiRes = await page.request.get("/api/analytics");
  expect(apiRes.ok()).toBeTruthy();
  const apiData = await apiRes.json();
  expect(apiData.platforms).toHaveLength(4);
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
