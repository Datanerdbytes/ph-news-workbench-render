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

  // One published post linked to a published draft — the same publish
  // recorded twice — and one published post with no draft.
  await seedPublishedPublishes();

  const after = await publishedTotal(page);

  // Two publishes, not three: the linked one is one publish, whatever it
  // was recorded as. This runs the overlap query against the database, so
  // a wrong subtraction fails here.
  expect(after - before).toBe(2);
});
