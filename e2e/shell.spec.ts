import { expect, test } from "@playwright/test";

test("renders the dashboard activity feed", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Activity log" })
  ).toBeVisible();
  // While the route hydrates the DOM can briefly hold two copies of the
  // page, so the loading copy is located without insisting on a single
  // match — the question is whether it is still visible.
  await expect(page.getByText("Loading your workspace…").first()).toBeHidden();
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

  // Same as above: the hydrating DOM can hold two copies, so nothing here
  // may insist on a single match.
  const totalCard = page
    .locator("article")
    .filter({ hasText: "Total published" })
    .first();
  await expect(totalCard).toBeVisible();
  await expect(
    totalCard.getByText(String(facebook.published.total), { exact: true })
  ).toBeVisible();
  await expect(
    page
      .getByText(new RegExp(`${facebook.published30d.total} in the last 30 days`))
      .first()
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
  await expect(page.getByRole("heading", { name: "Content Calendar", exact: true }))
    .toBeVisible();
  await expect(page.getByRole("heading", { name: "Scheduled" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Today" })).toBeVisible();
});

test("the retired Story Queue is gone and Sources owns the drafting flow", async ({
  page,
}) => {
  await page.goto("/dashboard");

  // Neither the sidebar entry nor the header quick link may bring it back.
  const sidebar = page.locator("aside nav[aria-label='Workspace navigation']");
  await expect(sidebar.getByRole("link", { name: "Story Queue" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Story Queue" })).toHaveCount(0);

  // The page itself is retired — it answers 404 instead of a redirect.
  const gone = await page.goto("/queue");
  expect(gone?.status()).toBe(404);

  // The root still lands somewhere real: Sources, where stories are drafted.
  await page.goto("/");
  await expect(page).toHaveURL(/\/sources/);
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
