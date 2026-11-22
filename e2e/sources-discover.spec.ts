import { expect, test, type Page } from "@playwright/test";

// The Discover flow is stubbed at the network boundary so the spec exercises
// the page wiring without touching the real feed index or the database: the
// search/preview endpoints serve fixtures and the add-source POST is
// intercepted (its body is asserted, nothing is inserted).
const DISCOVER_FEED_URL = "https://e2e-discover.test/feed/";

const searchFixture = {
  sources: [
    {
      feedUrl: DISCOVER_FEED_URL,
      title: "E2E Discover Feed",
      description: "Seeded by the regression suite.",
      siteUrl: "https://e2e-discover.test/",
      subscribers: 1_340_140,
      iconUrl: null,
      language: "en",
    },
    {
      feedUrl: "https://e2e-discover.test/added/",
      title: "E2E Already Added",
      description: "",
      siteUrl: "https://e2e-discover.test/added/",
      subscribers: 8200,
      iconUrl: null,
      language: "en",
    },
  ],
};

const previewFixture = {
  feed: {
    title: "E2E Discover Feed",
    description: "Seeded by the regression suite.",
    url: DISCOVER_FEED_URL,
    siteUrl: "https://e2e-discover.test/",
  },
  items: [
    {
      title: "E2E discover story one",
      link: "https://e2e-discover.test/one",
      published_at: new Date().toISOString(),
      image_url: null,
    },
    {
      title: "E2E discover story two",
      link: "https://e2e-discover.test/two",
      published_at: new Date().toISOString(),
      image_url: null,
    },
  ],
};

async function stubDiscoverApis(page: Page) {
  let feedAdded = false;
  await page.route("**/api/discover/search*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(searchFixture),
    }),
  );
  await page.route("**/api/sources/preview*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(previewFixture),
    }),
  );
  await page.route("**/api/sources*", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as {
        url?: string;
        category?: string;
      };
      expect(body.url).toBe(DISCOVER_FEED_URL);
      expect(body.category).toBe("Tech");
      feedAdded = true;
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ feed: { id: 99, title: "E2E Discover Feed" } }),
      });
    }
    const feeds = feedAdded
      ? [
          { id: 99, url: DISCOVER_FEED_URL, title: "E2E Discover Feed", enabled: true },
        ]
      : [
          { id: 8, url: "https://e2e-discover.test/added/", title: "E2E Already Added", enabled: true },
        ];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ feeds }),
    });
  });
}

test.describe("Discover sources", () => {
  test("home shows topics and the popular grid", async ({ page }) => {
    await stubDiscoverApis(page);
    await page.goto("/sources/discover");

    await expect(
      page.getByRole("heading", { name: "Popular right now" })
    ).toBeVisible();

    const topics = page.getByRole("group", { name: "Browse topics" });
    await expect(topics.getByText("Philippines")).toBeVisible();
    await expect(topics.getByText("Tech")).toBeVisible();

    await expect(page.getByText("E2E Discover Feed")).toBeVisible();
    await expect(page.getByText("1.3M followers")).toBeVisible();
    await expect(page.getByText("Added", { exact: true })).toBeVisible();
  });

  test("topic deep link shows the topic page and adds a source", async ({
    page,
  }) => {
    await stubDiscoverApis(page);
    await page.goto("/sources/discover?query=topic/tech");

    await expect(page.getByRole("heading", { name: "Tech" })).toBeVisible();

    // Preview the source: the modal lists the fixture stories.
    await page.getByRole("button", { name: "Preview latest stories" }).first().click();
    const dialog = page.locator("body").getByText("Source preview");
    await expect(dialog).toBeVisible();
    await expect(page.getByText("E2E discover story one")).toBeVisible();

    // Adding posts the feed URL with the topic pre-filled as its group.
    const addResponse = page.waitForResponse(
      (res) =>
        res.url().includes("/api/sources") && res.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Add source" }).click();
    const response = await addResponse;
    expect(response.ok()).toBeTruthy();

    await expect(page.getByText("Source added")).toBeVisible();
    await page.getByLabel("Close", { exact: true }).click();
    await expect(page.getByText("Added", { exact: true })).toBeVisible();
  });
});
