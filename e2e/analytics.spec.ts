import { expect, test, type Page } from "@playwright/test";
import {
  clearSeededPublishes,
  seedPublishedPublishes,
} from "./helpers/db";

/** The workspace-wide published count the analytics endpoint reports. */
async function publishedTotal(page: Page) {
  const res = await page.request.get("/api/analytics");
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  return data.totals.published as number;
}

test.afterEach(async () => {
  await clearSeededPublishes();
});

test("counts a publish that flipped its draft once", async ({ page }) => {
  const before = await publishedTotal(page);

  // Two published posts linked to the same published draft — that draft
  // published twice — and one published post with no draft.
  await seedPublishedPublishes();

  const after = await publishedTotal(page);

  // Three publishes, not four: the linked ones are two publishes, whatever
  // they were recorded as. This runs the overlap query against the
  // database, so counting the linked posts as rows instead of distinct
  // drafts fails here.
  expect(after - before).toBe(3);
});
