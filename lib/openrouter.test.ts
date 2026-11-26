import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));

import { sql } from "@/lib/db";
import { DEFAULT_TEXT_MODEL, TEXT_MODELS } from "./models";
import { defaultTextModel, draftPost, resolveTextModel } from "./openrouter";

const sqlMock = sql as unknown as Mock;

const completion = (
  content: string,
  prompt = 10,
  completionTokens = 20,
  finishReason = "stop"
) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: { prompt_tokens: prompt, completion_tokens: completionTokens },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

const notFound = () =>
  new Response("No endpoints found matching your data query", { status: 404 });

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([{ total_tokens: 30 }]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// Candidates always run requested-model-first, then the rest of the catalog
// in its declared order.
const candidateIds = (requested: string) => [
  requested,
  ...TEXT_MODELS.map((entry) => entry.id).filter((id) => id !== requested),
];

describe("model resolution", () => {
  it("honors a valid OPENROUTER_MODEL override", () => {
    vi.stubEnv("OPENROUTER_MODEL", "inclusionai/ling-3.2-flash:free");
    expect(defaultTextModel()).toBe("inclusionai/ling-3.2-flash:free");
  });

  it("falls back to the default for invalid or blank overrides", () => {
    vi.stubEnv("OPENROUTER_MODEL", "not-a-model");
    expect(defaultTextModel()).toBe(DEFAULT_TEXT_MODEL);
    vi.stubEnv("OPENROUTER_MODEL", "   ");
    expect(defaultTextModel()).toBe(DEFAULT_TEXT_MODEL);
  });

  it("prefers a valid workspace model over the default", () => {
    vi.stubEnv("OPENROUTER_MODEL", "baidu/ernie-5.5-flash-preview:free");
    expect(resolveTextModel("  google/gemma-4-26b-a4b-it:free  ")).toBe(
      "google/gemma-4-26b-a4b-it:free"
    );
    expect(resolveTextModel("bogus")).toBe(
      "baidu/ernie-5.5-flash-preview:free"
    );
    expect(resolveTextModel(null)).toBe(
      "baidu/ernie-5.5-flash-preview:free"
    );
    expect(TEXT_MODELS.length).toBeGreaterThan(0);
    // The catalog is free-tier only: every id must be a :free entry.
    expect(TEXT_MODELS.every((model) => model.id.endsWith(":free"))).toBe(
      true
    );
  });
});

describe("draftPost", () => {
  it("returns the draft text, served model, usage, and zero cost", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion("Hello draft"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_BASE_URL", "https://openrouter.test/api/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "key-123");

    await expect(draftPost("write something")).resolves.toEqual({
      text: "Hello draft",
      model: DEFAULT_TEXT_MODEL,
      inputTokens: 10,
      outputTokens: 20,
      estimatedCost: 0,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://openrouter.test/api/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer key-123");
    expect(init.headers["X-Title"]).toBe("PH News Workbench");
    const body = JSON.parse(init.body);
    expect(body.model).toBe(DEFAULT_TEXT_MODEL);
    // Reasoning models must answer directly, or the hidden reasoning eats the
    // whole max_tokens budget and the draft comes back empty.
    expect(body.reasoning).toEqual({ enabled: false });
    // The output limit is its own, smaller budget — not the per-draft cap,
    // which also has to cover the article text in the prompt.
    expect(body.max_tokens).toBe(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the requested model when one is passed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion("ok"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_API_KEY", "key-123");

    const result = await draftPost(
      "write something",
      "google/gemma-4-26b-a4b-it:free"
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(
      "google/gemma-4-26b-a4b-it:free"
    );
    expect(result.model).toBe("google/gemma-4-26b-a4b-it:free");
  });

  it("falls back to the next catalog model when the id is retired", async () => {
    // 404 twice, then a healthy answer from the third candidate.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(completion("Recovered"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_API_KEY", "key-123");

    const result = await draftPost("write something");
    expect(result.model).toBe(candidateIds(DEFAULT_TEXT_MODEL)[2]);
    expect(result.text).toBe("Recovered");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const requestedModels = fetchMock.mock.calls.map(
      (call) => JSON.parse(call[1].body).model
    );
    // Only the candidates actually tried: two 404s plus the one that answered.
    expect(requestedModels).toEqual(candidateIds(DEFAULT_TEXT_MODEL).slice(0, 3));
    // The failed attempts never recorded usage — only the answered call did.
    expect(sqlMock.mock.calls.filter((call) =>
      call[0].join(" ").includes("INSERT INTO usage_daily")
    ).length).toBe(1);
  });

  it("treats an unknown model id (400) as retired too", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('"bogus-model" is not a valid model ID', { status: 400 })
      )
      .mockResolvedValueOnce(completion("Recovered"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_API_KEY", "key-123");

    const result = await draftPost("hi", "bogus-model");
    expect(result.text).toBe("Recovered");
    // The catalog follows the requested model in its declared order.
    expect(result.model).toBe(TEXT_MODELS[0].id);
  });

  it("falls back when a shared provider throttles upstream", async () => {
    const throttled = () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Provider returned error",
            code: 429,
            metadata: {
              raw: `${DEFAULT_TEXT_MODEL} is temporarily rate-limited upstream. Please retry shortly.`,
              provider_name: "Google AI Studio",
            },
          },
        }),
        { status: 429 }
      );
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => throttled())
      .mockImplementationOnce(async () => throttled())
      .mockResolvedValueOnce(completion("Recovered"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_API_KEY", "key-123");

    const result = await draftPost("hi");
    expect(result.text).toBe("Recovered");
    expect(result.model).toBe(candidateIds(DEFAULT_TEXT_MODEL)[2]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never retries the account's own free-tier daily limit", async () => {
    // Every free model shares this quota — a retry burns requests for nothing.
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response("Rate limit exceeded: free-models-per-day (used: 50, limit: 50)", {
        status: 429,
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_API_KEY", "key-123");

    await expect(draftPost("hi")).rejects.toThrow(
      "OpenRouter 429: Rate limit exceeded"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("omits the reasoning flag for endpoints that force reasoning on", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion("ok"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_API_KEY", "key-123");

    // ERNIE's endpoint answers 400 "Reasoning is mandatory for this endpoint"
    // if the flag is sent, so the request must carry no reasoning param —
    // and the hidden reasoning needs room in the output budget.
    const result = await draftPost("hi", "baidu/ernie-5.5-flash-preview:free");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reasoning).toBeUndefined();
    expect(body.max_tokens).toBe(2000);
    expect(result.model).toBe("baidu/ernie-5.5-flash-preview:free");
  });

  it("falls back to the next model on an empty or cut-off reply", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(completion("   "))
      // Non-empty but truncated: it must not be stored as a finished draft.
      .mockResolvedValueOnce(
        completion("A post that stops mid-sent", 10, 900, "length")
      )
      .mockResolvedValueOnce(completion("Recovered"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_API_KEY", "key-123");

    const result = await draftPost("write something");
    expect(result.text).toBe("Recovered");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a cut-off reply that already overran the draft cap", async () => {
    // The spend guard wins over retry eligibility: fallback would multiply an
    // already overspent request across the whole catalog.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(completion("cut off", 4000, 900, "length"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_API_KEY", "key-123");

    await expect(draftPost("hi")).rejects.toThrow("per-draft cap exceeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports exhaustion after every catalog model fails", async () => {
    // A Response body can only be read once — each attempt needs a fresh one.
    const fetchMock = vi.fn().mockImplementation(async () => notFound());
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_API_KEY", "key-123");

    await expect(draftPost("hi")).rejects.toThrow(
      "The AI could not write the draft with any available model. Try again shortly."
    );
    expect(fetchMock).toHaveBeenCalledTimes(TEXT_MODELS.length);
  });

  it("never retries rate limits — they would burn the free quota", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Rate limit exceeded", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_API_KEY", "key-123");

    await expect(draftPost("hi")).rejects.toThrow(
      "OpenRouter 429: Rate limit exceeded"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces other HTTP failures without retrying", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 503 }))
    );
    await expect(draftPost("hi")).rejects.toThrow("OpenRouter 503: boom");
  });

  it("rejects when every model overruns the per-draft cap", async () => {
    // 4,500 total tokens against the 4,000 default cap; a spend guard is not
    // retryable — every model given the same prompt would overspend too.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(completion("big", 4000, 500))
    );
    await expect(draftPost("hi")).rejects.toThrow("per-draft cap exceeded");
    expect(
      sqlMock.mock.calls[0][0].join(" ").includes("INSERT INTO usage_daily")
    ).toBe(true);
  });

  it("enforces the daily token cap after recording usage", async () => {
    // Small per-draft usage (30 tokens) but a large accumulated daily total.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion("ok")));
    sqlMock
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [{ total_tokens: 65_000 }]);

    await expect(draftPost("hi")).rejects.toThrow("daily cap exceeded");
    expect(
      sqlMock.mock.calls[0][0].join(" ").includes("INSERT INTO usage_daily")
    ).toBe(true);
  });

  it("distinguishes timeouts from other network failures", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));
    await expect(draftPost("hi")).rejects.toThrow(
      "The AI model took too long to respond. Try a faster model."
    );

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(draftPost("hi")).rejects.toThrow(
      "Could not reach the OpenRouter endpoint."
    );
  });
});
