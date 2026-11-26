import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchPublicDocumentMock } = vi.hoisted(() => ({
  fetchPublicDocumentMock: vi.fn(),
}));

vi.mock("./article-image", () => ({
  ARTICLE_HEADERS: { "User-Agent": "test-agent", Accept: "text/html" },
  fetchPublicDocument: fetchPublicDocumentMock,
}));

import { fetchArticleText } from "./article-fetch";

const story = (paragraphs: number) =>
  `<html><body><article>${Array.from(
    { length: paragraphs },
    (_, i) => `<p>Paragraph ${i}: ${"A detail from the news story. ".repeat(4)}</p>`
  ).join("")}</article></body></html>`;

const document = (text: string, status = 200, contentType = "text/html") => ({
  status,
  contentType,
  finalUrl: "https://news.example/story",
  text,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchArticleText", () => {
  it("returns the article text read from the page", async () => {
    fetchPublicDocumentMock.mockResolvedValue(document(story(12)));
    const text = await fetchArticleText("https://news.example/story");
    expect(text.split("\n\n")).toHaveLength(12);
    expect(text).toContain("Paragraph 11:");
  });

  it("goes through the public-source transport, bounded and HTML only", async () => {
    fetchPublicDocumentMock.mockResolvedValue(document(story(12)));
    await fetchArticleText("https://news.example/story");

    const [url, opts] = fetchPublicDocumentMock.mock.calls[0];
    expect(url).toBe("https://news.example/story");
    expect(opts.headers["User-Agent"]).toBe("test-agent");
    expect(opts.acceptContentTypes.test("text/html; charset=utf-8")).toBe(true);
    expect(opts.acceptContentTypes.test("application/pdf")).toBe(false);
    // A slow or blocked site must not hold the draft for long.
    expect(opts.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(opts.maxBytes).toBeGreaterThan(500_000);
  });

  it("resolves to '' when the site refuses or cannot be reached", async () => {
    fetchPublicDocumentMock.mockResolvedValueOnce(document("", 403));
    await expect(fetchArticleText("https://news.example/story")).resolves.toBe("");

    fetchPublicDocumentMock.mockResolvedValueOnce(null);
    await expect(fetchArticleText("https://news.example/story")).resolves.toBe("");
  });

  it("resolves to '' when the response is not HTML or has no readable article", async () => {
    fetchPublicDocumentMock.mockResolvedValueOnce(document("", 200, "application/pdf"));
    await expect(fetchArticleText("https://news.example/story")).resolves.toBe("");

    fetchPublicDocumentMock.mockResolvedValueOnce(
      document("<html><body><div>No paragraphs here.</div></body></html>")
    );
    await expect(fetchArticleText("https://news.example/story")).resolves.toBe("");
  });

  it("resolves to '' when the transport throws", async () => {
    fetchPublicDocumentMock.mockRejectedValueOnce(new Error("blocked by policy"));
    await expect(fetchArticleText("not a url")).resolves.toBe("");
  });
});
