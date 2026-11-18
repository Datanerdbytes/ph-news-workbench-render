import { expect, test } from "@playwright/test";
import {
  clearSeededLiveStreams,
  liveStreamsColumns,
  seedSourcelessLiveStream,
} from "./helpers/db";

test.afterEach(async () => {
  await clearSeededLiveStreams();
});

// The four live-restream columns migrate-live-restream.mjs adds (and
// lib/schema.sql carries for fresh installs). prepare-e2e-db.mjs asserts the
// same list while provisioning — the suite never runs that script itself
// (it re-applies every migration and spawns a process per migration file, a
// nested run inside Playwright), so the provisioning gate below asserts the
// end state it guarantees instead.
const LIVE_RESTREAM_COLUMNS = [
  "source_url",
  "pump_status",
  "pump_started_at",
  "pump_error",
];

test("resolve rejects a non-URL before yt-dlp can run", async ({ page }) => {
  // 'not-a-url' has no scheme: lib/live/resolve.ts rejects it with
  // ResolveError invalid_url before building any candidate command line, so
  // no yt-dlp process is ever spawned — the whole suite stays network-free.
  const response = await page.request.post("/api/live/resolve", {
    data: { url: "not-a-url" },
  });

  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.code).toBe("invalid_url");
  // The message is friendly by construction — raw yt-dlp stderr never leaves
  // the resolver, and there was no stderr here at all.
  expect(body.error).toContain("http");
});

test("the Live Page renders the source composer controls", async ({ page }) => {
  await page.goto("/live");

  // The composer card: Source URL field + Preview button, and the rights
  // hint that must stay visible wherever a restream source can be pasted.
  await expect(page.locator("#live-source-url")).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview" })).toBeVisible();
  await expect(
    page.getByText("Only stream content you own or have licensed.")
  ).toBeVisible();
});

test("pump start without a source is guarded and the Live Page still renders", async ({
  page,
}) => {
  // The guard target: an ended stream with no source. ENDED keeps every
  // Facebook refresh path away from the row (loadRows only refreshes
  // non-ended streams, and this suite never sends ?refresh=1).
  const ended = await seedSourcelessLiveStream("ENDED");
  // A second sourceless row with a live status renders the card's pump
  // controls, so the UI pass can assert the disabled Go live affordance.
  const live = await seedSourcelessLiveStream("LIVE_NOW");

  // The API guard: a start against a sourceless stream must answer 4xx
  // without spawning anything — the guard runs before ffmpeg could ever be
  // reached, so this POST is process-free and network-free.
  const endedStart = await page.request.post(`/api/live/${ended.id}/pump`, {
    data: { action: "start" },
  });
  expect(endedStart.status()).toBe(400);
  const endedBody = await endedStart.json();
  expect(endedBody.error).toContain("Resolve a source URL");

  const liveStart = await page.request.post(`/api/live/${live.id}/pump`, {
    data: { action: "start" },
  });
  expect(liveStart.status()).toBe(400);
  expect((await liveStart.json()).error).toContain("Resolve a source URL");

  // The UI pass: /live still renders after the refused starts — the composer
  // is intact and both cards show the right affordance. The ended card hides
  // its pump controls entirely (components/live/source-preview.tsx renders
  // PumpControls only for non-ended streams); the live card without a source
  // shows a disabled Go live plus the hint explaining why.
  await page.goto("/live");

  await expect(page.getByRole("button", { name: "Preview" })).toBeVisible();
  await expect(
    page.getByText("ENDED", { exact: true })
  ).toBeVisible();

  const goLive = page.getByRole("button", { name: "Go live" });
  await expect(goLive).toHaveCount(1);
  await expect(goLive).toBeDisabled();
  await expect(
    page.getByText("Resolve and preview a source URL for this stream to go live.")
  ).toBeVisible();

  // Nothing ever spawns: a sourceless stream can never offer Stop.
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
});

test("the e2e database carries the live-restream columns", async () => {
  // Provisioning runs before the suite (CI calls prepare-e2e-db.mjs, which
  // exits 0 with `prepared: true` only when every migration applied and the
  // required columns verified). This asserts the same end state through the
  // shared connection instead of spawning the script a second time.
  const columns = await liveStreamsColumns();
  expect(columns).toEqual(expect.arrayContaining(LIVE_RESTREAM_COLUMNS));
});
