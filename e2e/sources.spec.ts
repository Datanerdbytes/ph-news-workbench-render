import { expect, test } from "@playwright/test";
import {
  clearSeededSourcesRedesignData,
  seedSourcesRedesignData,
} from "./helpers/db";
import { ensureOwnerSession } from "./helpers/session";

let vergeFeedId = 0;

test.beforeEach(async ({ page }, testInfo) => {
  const seeded = await seedSourcesRedesignData();
  vergeFeedId = seeded.vergeFeedId;
  // shell.spec signs the shared storage-state session out before this spec
  // runs; establish a fresh session in this context so the APIs answer.
  await ensureOwnerSession(
    page,
    new URL(testInfo.project.use.baseURL ?? "http://localhost:3000").origin,
  );
});

test.afterEach(async () => {
  await clearSeededSourcesRedesignData();
});

test("groups sources in the sidebar and browses articles per source", async ({
  page,
}) => {
  await page.goto("/sources");

  const sidebar = page.getByRole("navigation", { name: "Source list" });
  await expect(sidebar.getByText("Tech")).toBeVisible();
  await expect(sidebar.getByText("E2E Verge")).toBeVisible();
  await expect(sidebar.getByText("Ungrouped")).toBeVisible();
  await expect(sidebar.getByText("E2E Solo")).toBeVisible();

  // The combined view lists every seeded story under its date group.
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByText("E2E sources story one")).toBeVisible();
  await expect(page.getByText("E2E solo story")).toBeVisible();

  // Selecting a source filters the list and mirrors the selection in the URL.
  await sidebar.getByRole("button", { name: /E2E Verge/ }).click();
  await expect(page).toHaveURL(/\/sources\?feed=\d+/);
  await expect(page.getByRole("heading", { name: "E2E Verge" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fetch now" })).toBeVisible();
  await expect(page.getByText("E2E sources story one")).toBeVisible();
  await expect(page.getByText("E2E solo story")).toHaveCount(0);
});

test("deep-links straight to a source", async ({ page }) => {
  await page.goto(`/sources?feed=${vergeFeedId}`);

  await expect(page.getByRole("heading", { name: "E2E Verge" })).toBeVisible();
  await expect(page.getByText("E2E sources story one")).toBeVisible();
  await expect(page.getByText("E2E solo story")).toHaveCount(0);
});
