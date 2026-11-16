import { expect, test } from "@playwright/test";
import { clearSeededNotifications, seedNotifications } from "./helpers/db";

test.beforeEach(async () => {
  await seedNotifications(2);
});

test.afterEach(async () => {
  await clearSeededNotifications();
});

test("shows the unread badge, lists rows, and marks all read", async ({
  page,
}) => {
  await page.goto("/dashboard");

  const bell = page.getByRole("button", { name: "Notifications, 2 unread" });
  await expect(bell).toBeVisible();
  await bell.click();

  await expect(page.getByText("Regression seed 1")).toBeVisible();
  await expect(page.getByText("Regression seed 2")).toBeVisible();

  const markAllResponse = page.waitForResponse(
    (res) =>
      res.url().includes("/api/notifications/read") &&
      res.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Mark all read" }).click();
  const response = await markAllResponse;
  expect(response.ok()).toBeTruthy();
  await expect(
    page.getByRole("button", { name: "Mark all read" })
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Notifications", exact: true })
  ).toBeVisible();

  // The bell starts with unread = 0, so the badge assertions below would pass
  // before the server answered. Arm a waiter for the notifications GET, reload,
  // and assert the persisted count the reloaded page receives. The start-time
  // filter keeps a response from the outgoing page — whose body dies with the
  // navigation — from satisfying the waiter.
  const reloadingAt = Date.now();
  const persistedResponse = page.waitForResponse(
    (res) => {
      if (!res.url().includes("/api/notifications")) return false;
      if (res.request().method() !== "GET") return false;
      const startedAt = res.request().timing().startTime;
      return startedAt === -1 || startedAt >= reloadingAt;
    }
  );
  await page.reload();
  const persisted = await persistedResponse;
  expect(persisted.ok()).toBeTruthy();
  const persistedBody = (await persisted.json()) as { unread: number };
  expect(persistedBody.unread).toBe(0);

  await expect(
    page.getByRole("button", { name: "Notifications", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Notifications, 2 unread" })
  ).toHaveCount(0);
});

test("marks a row read and follows its link", async ({ page }) => {
  await page.goto("/dashboard");

  await page
    .getByRole("button", { name: "Notifications, 2 unread" })
    .click();
  await page.getByRole("button", { name: /Regression seed 1/ }).click();

  await expect(page).toHaveURL(/\/calendar/);
});
