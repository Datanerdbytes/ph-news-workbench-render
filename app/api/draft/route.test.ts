import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  sqlMock,
  requireWorkspaceMock,
  draftPostMock,
  resolveTextModelMock,
  fetchArticleTextMock,
} = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  requireWorkspaceMock: vi.fn(),
  draftPostMock: vi.fn(),
  resolveTextModelMock: vi.fn(() => "google/gemma-4-31b-it:free"),
  fetchArticleTextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ sql: sqlMock }));
vi.mock("@/lib/session", () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () =>
    new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
}));
vi.mock("@/lib/openrouter", () => ({
  draftPost: draftPostMock,
  resolveTextModel: resolveTextModelMock,
}));
vi.mock("@/lib/article-fetch", () => ({ fetchArticleText: fetchArticleTextMock }));

import { POST } from "./route";

const access = { user: { id: "u1" }, workspace: { id: "ws1" } };

const LEDE =
  "The Department of Transportation said on Tuesday it would review the supply and demand of public utility vehicles nationwide.";
const detail = (i: number) =>
  `Detail ${i}: ${"transport groups asked for more time to comply with the rules. ".repeat(3).trim()}.`;
const article = Array.from({ length: 12 }, (_, i) => detail(i)).join(" ");

// A story whose feed publishes only the lede.
const story = (overrides: Record<string, unknown> = {}) => ({
  title: "DOTr to review transport supply and demand",
  summary: LEDE,
  link: "https://news.example/story",
  raw_payload: { content: `<p>${LEDE}</p>`, contentSnippet: LEDE },
  ...overrides,
});

const reply = (overrides: Record<string, unknown> = {}) => ({
  text: "The post.",
  model: "google/gemma-4-31b-it:free",
  inputTokens: 900,
  outputTokens: 120,
  estimatedCost: 0,
  ...overrides,
});

function draft(body: unknown = { newsItemId: 7, language: "en" }) {
  return POST(
    new Request("http://localhost/api/draft", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
}

const callText = (call: unknown[]) => (call[0] as TemplateStringsArray).join("?");
const promptSent = () => draftPostMock.mock.calls[0][0] as string;
const insertCall = () =>
  sqlMock.mock.calls.find((call) => callText(call).includes("INSERT INTO drafts"));

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([]);
  requireWorkspaceMock.mockResolvedValue(access);
  fetchArticleTextMock.mockResolvedValue("");
});

describe("POST /api/draft", () => {
  it("rewrites from the full article the feed carries, without fetching the page", async () => {
    sqlMock.mockResolvedValueOnce([
      story({
        raw_payload: {
          content: `<p>${LEDE}</p>`,
          "content:encoded": `<p>${article}</p>`,
        },
      }),
    ]);
    draftPostMock.mockResolvedValue(reply());

    const res = await draft();
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe("The post.");
    expect(fetchArticleTextMock).not.toHaveBeenCalled();

    expect(promptSent()).toContain(article);
    expect(promptSent()).toContain("in English");
    expect(promptSent()).toContain("under 120 words");
    expect(promptSent()).toContain("Return the post text only");
    expect(promptSent()).not.toContain("short summary only");
  });

  it("tops up a lede-only feed from the article page", async () => {
    sqlMock.mockResolvedValueOnce([story()]);
    fetchArticleTextMock.mockResolvedValue(article);
    draftPostMock.mockResolvedValue(reply());

    await draft({ newsItemId: 7, language: "tl" });
    expect(fetchArticleTextMock).toHaveBeenCalledWith("https://news.example/story");
    expect(promptSent()).toContain(article);
    expect(promptSent()).toContain("in Tagalog");
    expect(promptSent()).not.toContain("short summary only");
  });

  it("keeps to the lede when the article page cannot be read", async () => {
    sqlMock.mockResolvedValueOnce([story()]);
    draftPostMock.mockResolvedValue(reply());

    const res = await draft();
    expect(res.status).toBe(200);
    expect(promptSent()).toContain(LEDE);
    expect(promptSent()).toContain("short summary only");
    expect(promptSent()).toContain("write 2-3 sentences");
    expect(promptSent()).not.toContain("under 120 words");
  });

  it("keeps the lede when the page adds too little to be a source", async () => {
    // Four details is ~800 characters: under the threshold, so the page is tried.
    const fed = Array.from({ length: 4 }, (_, i) => detail(i)).join(" ");
    sqlMock.mockResolvedValueOnce([
      story({ summary: fed, raw_payload: { content: `<p>${fed}</p>` } }),
    ]);
    fetchArticleTextMock.mockResolvedValue(`${fed} Extra.`);
    draftPostMock.mockResolvedValue(reply());

    await draft();
    expect(fetchArticleTextMock).toHaveBeenCalledTimes(1);
    expect(promptSent()).toContain(fed);
    expect(promptSent()).not.toContain("Extra.");
    expect(promptSent()).toContain("short summary only");
  });

  it("asks for the headline alone when no text can be had", async () => {
    sqlMock.mockResolvedValueOnce([
      story({ summary: "", raw_payload: null }),
    ]);
    draftPostMock.mockResolvedValue(reply());

    await draft();
    expect(promptSent()).toContain("No article text is available: use only the headline.");
  });

  it("stores the model that actually answered, not the one requested", async () => {
    sqlMock.mockResolvedValueOnce([story()]);
    const served = "baidu/ernie-5.5-flash-preview:free";
    draftPostMock.mockResolvedValue(reply({ model: served }));

    const res = await draft();
    expect((await res.json()).model).toBe(served);

    // user, workspace, story, text, model
    expect(insertCall()?.slice(1, 6)).toEqual([
      "u1",
      "ws1",
      7,
      "The post.",
      served,
    ]);
  });

  it("records a failure and maps rate limits to 429", async () => {
    sqlMock.mockResolvedValueOnce([story()]);
    draftPostMock.mockRejectedValue(
      new Error("OpenRouter 429: Rate limit exceeded")
    );

    const res = await draft();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("OpenRouter 429: Rate limit exceeded");

    // Interpolated values only: user, workspace, story, model, id, message —
    // the empty text, the zero counts, and the 'failed' status are literals
    // in the SQL text itself.
    const call = insertCall();
    expect(call?.slice(1, 5)).toEqual([
      "u1",
      "ws1",
      7,
      "google/gemma-4-31b-it:free",
    ]);
    expect(callText(call ?? [])).toContain("'failed'");
    expect(call?.at(-1)).toBe("OpenRouter 429: Rate limit exceeded");
  });

  it("maps other upstream failures to 502", async () => {
    sqlMock.mockResolvedValueOnce([story()]);
    draftPostMock.mockRejectedValue(
      new Error("Could not reach the OpenRouter endpoint.")
    );

    const res = await draft();
    expect(res.status).toBe(502);
  });

  it("returns 404 when the story does not exist", async () => {
    sqlMock.mockResolvedValueOnce([]);

    const res = await draft();
    expect(res.status).toBe(404);
    expect(draftPostMock).not.toHaveBeenCalled();
    expect(fetchArticleTextMock).not.toHaveBeenCalled();
  });
});
