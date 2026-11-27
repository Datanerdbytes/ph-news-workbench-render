import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));

import { sql } from "@/lib/db";
import { buildTtsSsml, synthesizeSpeech } from "./azure";

const sqlMock = sql as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AZURE_SPEECH_KEY", "key-123");
  vi.stubEnv("AZURE_SPEECH_REGION", "southeastasia");
  vi.stubEnv("AZURE_SPEECH_ENDPOINT", "https://speech.test");
  sqlMock.mockResolvedValue([{ requests: 1, characters: 12 }]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("buildTtsSsml", () => {
  it("escapes draft text and applies the selected voice and speed", () => {
    const ssml = buildTtsSsml(
      'A & <B> "C"',
      "fil-PH-BlessicaNeural",
      1.1,
    );
    expect(ssml).toContain(
      'xmlns="http://www.w3.org/2001/10/synthesis"',
    );
    expect(ssml).toContain('xml:lang="fil-PH"');
    expect(ssml).toContain('name="fil-PH-BlessicaNeural"');
    expect(ssml).toContain('rate="+10%"');
    expect(ssml).toContain("A &amp; &lt;B&gt; &quot;C&quot;");
  });
});

describe("synthesizeSpeech", () => {
  it("reserves quota and returns provider audio", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesizeSpeech({
      text: "Hello there.",
      voiceId: "en-PH-RosaNeural",
      speed: 1,
      workspaceId: "ws1",
      correlationId: "corr-1",
    });

    expect(result.audio.byteLength).toBe(3);
    expect(result.voiceId).toBe("en-PH-RosaNeural");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://speech.test/cognitiveservices/v1",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Ocp-Apim-Subscription-Key": "key-123",
          "X-Microsoft-OutputFormat": "audio-48khz-192kbitrate-mono-mp3",
        }),
        body: expect.stringContaining("Hello there."),
      }),
    );
    expect(sqlMock.mock.calls[0][0].join("?")).toContain("tts_usage_daily");
  });

  it("does not call the provider when the daily quota is full", async () => {
    sqlMock.mockResolvedValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      synthesizeSpeech({
        text: "Hello there.",
        voiceId: "en-PH-RosaNeural",
        speed: 1,
        workspaceId: "ws1",
        correlationId: "corr-2",
      }),
    ).rejects.toMatchObject({ status: 429, code: "quota_exceeded" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails before quota or network calls when credentials are missing", async () => {
    vi.stubEnv("AZURE_SPEECH_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      synthesizeSpeech({
        text: "Hello there.",
        voiceId: "en-PH-RosaNeural",
        speed: 1,
        workspaceId: "ws1",
        correlationId: "corr-3",
      }),
    ).rejects.toMatchObject({ status: 503, code: "not_configured" });
    expect(sqlMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps upstream rate limits without exposing the provider body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("secret upstream detail", { status: 429 }),
      ),
    );

    const error = await synthesizeSpeech({
      text: "Hello there.",
      voiceId: "en-PH-RosaNeural",
      speed: 1,
      workspaceId: "ws1",
      correlationId: "corr-4",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 429, code: "rate_limited" });
    expect((error as Error).message).not.toContain("secret upstream detail");
  });

  it("maps provider timeouts to a safe 504", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")),
    );

    await expect(
      synthesizeSpeech({
        text: "Hello there.",
        voiceId: "en-PH-RosaNeural",
        speed: 1,
        workspaceId: "ws1",
        correlationId: "corr-5",
      }),
    ).rejects.toMatchObject({ status: 504, code: "timeout" });
  });
});
