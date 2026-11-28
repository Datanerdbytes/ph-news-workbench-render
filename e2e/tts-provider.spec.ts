import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { expect, test, type Page } from "@playwright/test";
import { requireEnv } from "./helpers/env";

const assemblyAiRadio = (page: Page) =>
  page.getByRole("radio", { name: /AssemblyAI/ });
const storyMarker = "e2e-tts-provider";
let storyId: number;

test.beforeAll(async () => {
  const sql = neon(requireEnv("DATABASE_URL"));
  const owners = (await sql`
    SELECT w.id AS workspace_id, wm.user_id
    FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.role = 'owner'
    ORDER BY w.created_at
    LIMIT 1
  `) as unknown as { workspace_id: string; user_id: string }[];
  const owner = owners[0];
  const runId = randomUUID();
  const feeds = (await sql`
    INSERT INTO feeds (workspace_id, url, title, category, enabled)
    VALUES (${owner.workspace_id}, ${`https://${storyMarker}.test/${runId}/rss.xml`},
            'TTS provider test', 'Tech', true)
    RETURNING id
  `) as unknown as { id: number }[];
  const stories = (await sql`
    INSERT INTO news_items
      (feed_id, workspace_id, guid, link, title, summary, published_at,
       created_at, raw_payload, dedup_hash)
    VALUES
      (${feeds[0].id}, ${owner.workspace_id}, ${`${storyMarker}-${runId}`},
       ${`https://${storyMarker}.test/${runId}/story`}, 'TTS provider browser story',
       'A synthetic story for provider selection coverage.', now(), now(), NULL,
       ${`${storyMarker}-${runId}-hash`})
    RETURNING id
  `) as unknown as { id: number }[];
  storyId = stories[0].id;
});

test.afterAll(async () => {
  const sql = neon(requireEnv("DATABASE_URL"));
  await sql`DELETE FROM news_items WHERE guid LIKE ${`${storyMarker}-%`}`;
  await sql`DELETE FROM feeds WHERE url LIKE ${`https://${storyMarker}.test/%`}`;
});

test.beforeEach(async ({ page }, testInfo) => {
  const origin = new URL(
    testInfo.project.use.baseURL ?? "http://localhost:3000",
  ).origin;
  const response = await page.request.post("/api/auth/sign-in/email", {
    headers: { origin },
    data: {
      email: requireEnv("OWNER_EMAIL"),
      password: requireEnv("OWNER_PASSWORD"),
    },
  });
  expect(response.ok()).toBeTruthy();
});

test.afterEach(async ({ page }) => {
  const response = await page.request.patch("/api/workspace", {
    data: { ttsProvider: "azure", assemblyaiApiKey: null, assemblyaiVoiceIds: [] },
  });
  expect(response.ok()).toBeTruthy();
});

test("saved AssemblyAI settings drive Compose without affecting avatars", async ({
  page,
}) => {
  await page.goto("/settings#text-to-speech");
  await expect(page.getByRole("heading", { name: "Text-to-speech" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Azure Speech/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await assemblyAiRadio(page).click();
  await expect(page.locator("#tts-settings-error")).toContainText(
    "Save an AssemblyAI API key below before switching providers.",
  );
  await expect(assemblyAiRadio(page)).toHaveAttribute("aria-checked", "false");

  await page.getByLabel("AssemblyAI API key").fill("e2e-not-a-real-assemblyai-key");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("API key saved.", { exact: true })).toBeVisible();
  await page.getByLabel("AssemblyAI cloned voice IDs").fill("e2e-cloned-voice");
  await page.getByRole("button", { name: "Save voice IDs" }).click();
  await expect(page.getByText("1 cloned voice saved.", { exact: true })).toBeVisible();
  await assemblyAiRadio(page).click();
  await expect(assemblyAiRadio(page)).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByText("AssemblyAI is ready for voice-over generation.", { exact: true }),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("AssemblyAI API key")).toHaveValue("");
  await expect(page.getByLabel("AssemblyAI cloned voice IDs")).toHaveValue(
    "e2e-cloned-voice",
  );
  await expect(assemblyAiRadio(page)).toHaveAttribute("aria-checked", "true");
  await page.locator("#text-to-speech").screenshot({
    path: test.info().outputPath("settings-assemblyai-desktop.png"),
  });

  await page.goto(`/compose?item=${storyId}`);
  await page.getByRole("textbox", { name: "Facebook post draft" }).fill(
    "A local browser test verifies the saved voice-over provider without generating audio.",
  );
  await page.getByRole("button", { name: "Voice-over", exact: true }).click();
  await expect(page.getByText("Provider: AssemblyAI", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Voice")).toHaveValue("aai-kyla");
  await expect(
    page.getByRole("option", { name: "Cloned · e2e-cloned-voice" }),
  ).toHaveCount(1);
  await page.getByLabel("Voice").selectOption("e2e-cloned-voice");
  await expect(page.getByLabel("Voice")).toHaveValue("e2e-cloned-voice");
  await page.getByLabel("Voice").selectOption("aai-peter");
  await expect(page.getByLabel("Voice")).toHaveValue("aai-peter");
  await expect(page.getByText("Natural (1.00×)", { exact: true })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Speaking speed" })).toHaveCount(0);

  await page
    .getByRole("group", { name: "Draft language" })
    .getByRole("button", { name: "TL" })
    .click();
  await expect(
    page.getByText(
      "AssemblyAI supports English voice-over only. Switch the draft to English or choose Azure Speech in Settings for Filipino or Tagalog.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate voice-over" })).toBeDisabled();

  await page.getByRole("button", { name: "Talking avatar", exact: true }).click();
  await expect(page.getByLabel("Voice")).toHaveValue("fil-PH-BlessicaNeural");
  await expect(page.getByLabel("Voice").locator('option[value="aai-peter"]')).toHaveCount(0);

  await page.goto("/settings#text-to-speech");
  await page.getByRole("button", { name: "Remove key" }).click();
  await page.getByRole("button", { name: "Confirm removal" }).click();
  await expect(page.getByText("No AssemblyAI API key saved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Azure Speech/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("TTS settings remain usable on a small screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/settings#text-to-speech");

  const section = page.locator("#text-to-speech");
  await expect(section).toBeVisible();
  await expect(
    page.getByText(
      "Choose the voice-over provider used by every composer in this workspace.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(assemblyAiRadio(page)).toBeEnabled();
  await expect(page.getByLabel("AssemblyAI API key")).toBeEnabled();
  await expect(page.getByLabel("AssemblyAI cloned voice IDs")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Save key" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save voice IDs" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await section.screenshot({
    path: test.info().outputPath("settings-tts-mobile.png"),
  });
});
