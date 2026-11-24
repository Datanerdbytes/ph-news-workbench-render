import { expect, test } from "@playwright/test";
import {
  clearSeededSourcesRedesignData,
  seedSourcesRedesignData,
} from "./helpers/db";
import { ensureOwnerSession } from "./helpers/session";

let seeded: Awaited<ReturnType<typeof seedSourcesRedesignData>>;

test.beforeEach(async ({ page }, testInfo) => {
  seeded = await seedSourcesRedesignData();
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

test("defaults to today's Manila stories and browses articles per source", async ({
  page,
}) => {
  await page.goto("/sources");

  const sidebar = page.getByRole("navigation", { name: "Source list" });
  await expect(sidebar.getByText("Tech")).toBeVisible();
  await expect(sidebar.getByText("E2E Verge")).toBeVisible();
  await expect(sidebar.getByText("Ungrouped")).toBeVisible();
  await expect(sidebar.getByText("E2E Solo")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByText("E2E sources story one")).toBeVisible();
  await expect(page.getByText("E2E sources story two")).toBeVisible();
  await expect(page.getByText("E2E solo story")).toBeVisible();
  await expect(page.getByText("E2E yesterday story")).toHaveCount(0);
  await expect(page.getByText("E2E tomorrow story")).toHaveCount(0);
  await expect(page.getByText("E2E previous month story")).toHaveCount(0);
  await expect(page.getByText("E2E undated story")).toHaveCount(0);
  await expect(page.getByLabel("Date range")).toHaveValue("today");

  await sidebar.getByRole("button", { name: /E2E Verge/ }).click();
  await expect(page).toHaveURL(/\/sources\?feed=\d+/);
  await expect(page.getByRole("heading", { name: "E2E Verge" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fetch now" })).toBeVisible();
  await expect(page.getByText("E2E sources story one")).toBeVisible();
  await expect(page.getByText("E2E solo story")).toHaveCount(0);
  await expect(page.getByLabel("Date range")).toHaveValue("today");
});

test("deep-links straight to a source while retaining the Today default", async ({
  page,
}) => {
  await page.goto(`/sources?feed=${seeded.vergeFeedId}`);

  await expect(page.getByRole("heading", { name: "E2E Verge" })).toBeVisible();
  await expect(page.getByText("E2E sources story one")).toBeVisible();
  await expect(page.getByText("E2E solo story")).toHaveCount(0);
  await expect(page.getByLabel("Date range")).toHaveValue("today");
});

test("filters by a specific day, a specific month, and all time", async ({
  page,
}) => {
  await page.goto(`/sources?range=day&date=${seeded.previousDay}`);

  await expect(page.getByRole("heading", { name: "Yesterday", exact: true })).toBeVisible();
  await expect(page.getByText("E2E yesterday story")).toBeVisible();
  await expect(page.getByText("E2E sources story one")).toHaveCount(0);

  await page.getByLabel("Date range").selectOption("month");
  await page.getByLabel("Month").fill(seeded.previousMonth);
  await expect(page).toHaveURL(
    url => url.searchParams.get("range") === "month"
      && url.searchParams.get("month") === seeded.previousMonth,
  );
  await expect(page.getByText("E2E previous month story")).toBeVisible();
  await expect(page.getByText("E2E sources story one")).toHaveCount(0);

  await page.getByLabel("Date range").selectOption("all");
  await expect(page.getByText("E2E undated story")).toBeVisible();
  await expect(page.getByText("E2E tomorrow story")).toBeVisible();
  await expect(page.getByText("E2E previous month story")).toBeVisible();
});

test("searches topics, people, sources, and RSS metadata", async ({ page }) => {
  await page.goto("/sources");
  const search = page.getByRole("searchbox", { name: "Search stories" });

  await search.fill("Maria Santos climate");
  await expect(page).toHaveURL(
    url => url.searchParams.get("q") === "Maria Santos climate",
  );
  await expect(page.getByText("E2E sources story one")).toBeVisible();
  await expect(page.getByText("E2E sources story two")).toHaveCount(0);
  await expect(page.getByText("E2E solo story")).toHaveCount(0);

  await page.getByRole("button", { name: "Clear story search" }).click();
  await expect(page.getByText("E2E solo story")).toBeVisible();

  await search.fill("Juan Dela Cruz");
  await expect(page.getByText("No stories match “Juan Dela Cruz”")).toBeVisible();
  await page.getByRole("button", { name: "Browse all time" }).click();
  await expect(page.getByText("E2E previous month story")).toBeVisible();
  await expect(page).toHaveURL(
    url => url.searchParams.get("range") === "all"
      && url.searchParams.get("q") === "Juan Dela Cruz",
  );

  await search.fill("E2E Solo");
  await expect(page.getByText("E2E solo story")).toBeVisible();
  await expect(page.getByText("E2E sources story one")).toHaveCount(0);
});

test("API applies Manila boundaries and returns exact filtered pagination totals", async ({
  page,
}) => {
  const feed = `feed=${seeded.vergeFeedId}`;
  const first = await page.request.get(
    `/api/source-items?${feed}&range=day&date=${seeded.today}&limit=1`,
  );
  expect(first.ok()).toBeTruthy();
  const firstPage = await first.json();
  expect(firstPage.total).toBe(2);
  expect(firstPage.rows).toHaveLength(1);
  expect(firstPage.hasMore).toBe(true);
  expect(firstPage.nextCursor).toEqual(expect.any(Number));

  const second = await page.request.get(
    `/api/source-items?${feed}&range=day&date=${seeded.today}&limit=1&before=${firstPage.nextCursor}`,
  );
  expect(second.ok()).toBeTruthy();
  const secondPage = await second.json();
  expect(secondPage.total).toBe(2);
  expect(secondPage.rows).toHaveLength(1);
  expect(secondPage.hasMore).toBe(false);

  const emptyCursor = await page.request.get(
    `/api/source-items?${feed}&range=day&date=${seeded.today}&before=1`,
  );
  const emptyPage = await emptyCursor.json();
  expect(emptyPage.rows).toEqual([]);
  expect(emptyPage.total).toBe(2);
  expect(emptyPage.hasMore).toBe(false);

  const previousDay = await page.request.get(
    `/api/source-items?${feed}&range=day&date=${seeded.previousDay}`,
  );
  expect((await previousDay.json()).rows.map((row: { title: string }) => row.title)).toEqual([
    "E2E yesterday story",
  ]);

  const allTime = await page.request.get(`/api/source-items?${feed}&range=all`);
  const allTimePayload = await allTime.json();
  expect(allTimePayload.total).toBe(6);
  expect(allTimePayload.rows.map((row: { title: string }) => row.title)).toContain(
    "E2E undated story",
  );

  const metadataSearch = await page.request.get(
    `/api/source-items?${feed}&q=Maria%20Santos%20climate`,
  );
  expect((await metadataSearch.json()).rows.map((row: { title: string }) => row.title)).toEqual([
    "E2E sources story one",
  ]);

  const invalid = await page.request.get(
    `/api/source-items?${feed}&range=day&date=2026-02-30`,
  );
  expect(invalid.status()).toBe(400);
});

test("restores filters on back and forward navigation", async ({ page }) => {
  await page.goto("/sources?range=all");
  await expect(page.getByLabel("Date range")).toHaveValue("all");
  await expect(page.getByText("E2E undated story")).toBeVisible();

  await page.goto(`/sources?range=month&month=${seeded.previousMonth}`);
  await expect(page.getByLabel("Month")).toHaveValue(seeded.previousMonth);
  await expect(page.getByText("E2E previous month story")).toBeVisible();

  await page.goBack();
  await expect(page.getByLabel("Date range")).toHaveValue("all");
  await expect(page.getByText("E2E undated story")).toBeVisible();

  await page.goForward();
  await expect(page.getByLabel("Month")).toHaveValue(seeded.previousMonth);
  await expect(page.getByText("E2E previous month story")).toBeVisible();
});

test("keeps the filter toolbar usable on a small phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/sources");

  await expect(page.getByRole("searchbox", { name: "Search stories" })).toBeVisible();
  await expect(page.getByLabel("Date range")).toBeVisible();
  await page.getByLabel("Date range").selectOption("month");
  await expect(page.getByLabel("Month")).toBeVisible();
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);

  await page.setViewportSize({ width: 812, height: 375 });
  await expect(page.getByRole("searchbox", { name: "Search stories" })).toBeVisible();
  await expect(page.getByLabel("Date range")).toBeVisible();
  await expect(page.getByLabel("Month")).toBeVisible();
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);
});
