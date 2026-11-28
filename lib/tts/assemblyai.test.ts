import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));

import { sql } from "@/lib/db";
import { synthesizeAssemblyAiSpeech } from "./assemblyai";

const sqlMock = sql as unknown as Mock;
type SpeechInput = Parameters<typeof synthesizeAssemblyAiSpeech>[0];

const baseInput: SpeechInput = {
  text: "Hello there.",
  voiceId: "aai-kyla",
  speed: 1,
  apiKey: "assemblyai-test-key",
  clonedVoiceIds: [],
  workspaceId: "ws-assemblyai",
  correlationId: "corr-assemblyai",
};

function synthesize(overrides: Partial<SpeechInput> = {}) {
  return synthesizeAssemblyAiSpeech({ ...baseInput, ...overrides });
}

function audioResponse(
  contentType = "audio/mpeg",
  bytes: number[] = [1, 2, 3],
) {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([{ requests: 1, characters: baseInput.text.length }]);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("synthesizeAssemblyAiSpeech", () => {
  it("reserves workspace quota and sends the expected MP3 request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(audioResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesize({
      text: "Hello & goodbye.",
      apiKey: "  assemblyai-test-key  ",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://tts.us.assemblyai.com/v1/speech");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "assemblyai-test-key",
        "User-Agent": "PH-News-Workbench/1.0",
        "X-Client-Request-Id": "corr-assemblyai",
      },
    });
    expect(JSON.parse(init.body)).toEqual({
      text: "Hello & goodbye.",
      voice_id: "aai-kyla",
      language: "english",
      encoding: "mp3",
      bit_rate: 64000,
      stream: false,
      speed: 1,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      audio: expect.any(ArrayBuffer),
      voiceId: "aai-kyla",
      characters: "Hello & goodbye.".length,
    });
    expect(new Uint8Array(result.audio)).toEqual(new Uint8Array([1, 2, 3]));

    const quotaCall = sqlMock.mock.calls[0];
    expect(quotaCall[0].join("?")).toContain("tts_usage_daily");
    expect(quotaCall[0].join("?")).toContain("VALUES (?, ?, 1, ?)");
    expect(quotaCall[1]).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(quotaCall[2]).toBe("ws-assemblyai");
    expect(quotaCall.slice(1)).toContain("Hello & goodbye.".length);
    expect(sqlMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0],
    );
  });

  it.each(["audio/mpeg", "audio/mp3"])(
    "accepts a non-empty %s response",
    async (contentType) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(audioResponse(contentType)));

      await expect(synthesize()).resolves.toMatchObject({
        voiceId: "aai-kyla",
        characters: baseInput.text.length,
      });
    },
  );

  it("accepts a workspace-configured cloned voice ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(audioResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      synthesize({
        voiceId: "cloned-voice-id",
        clonedVoiceIds: ["cloned-voice-id"],
      }),
    ).resolves.toMatchObject({ voiceId: "cloned-voice-id" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).voice_id).toBe(
      "cloned-voice-id",
    );
  });

  it.each([
    {
      label: "a missing key",
      overrides: { apiKey: "   " },
      status: 503,
      code: "not_configured",
    },
    {
      label: "an Azure voice",
      overrides: { voiceId: "en-PH-RosaNeural" },
      status: 400,
      code: "invalid_voice",
    },
    {
      label: "an unconfigured cloned voice",
      overrides: { voiceId: "cloned-voice-id" },
      status: 400,
      code: "invalid_voice",
    },
    {
      label: "a non-natural speed",
      overrides: { speed: 1.1 },
      status: 400,
      code: "fixed_speed",
    },
  ])("rejects $label before quota or network calls", async ({ overrides, status, code }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(synthesize(overrides)).rejects.toMatchObject({ status, code });
    expect(sqlMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call AssemblyAI when the daily quota is full", async () => {
    sqlMock.mockResolvedValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(synthesize()).rejects.toMatchObject({
      status: 429,
      code: "quota_exceeded",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects text over the character cap before quota or network calls", async () => {
    vi.stubEnv("TTS_DAILY_CHARACTER_CAP", "3");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(synthesize()).rejects.toMatchObject({
      status: 429,
      code: "quota_exceeded",
    });
    expect(sqlMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { upstream: 401, status: 503, code: "not_configured" },
    { upstream: 403, status: 403, code: "voice_access_denied" },
    { upstream: 402, status: 402, code: "insufficient_credits" },
    { upstream: 422, status: 400, code: "speech_rejected" },
    { upstream: 429, status: 429, code: "rate_limited" },
    { upstream: 500, status: 502, code: "provider_error" },
  ])("maps upstream $upstream to a safe $code error", async ({ upstream, status, code }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("sensitive upstream detail", { status: upstream }),
      ),
    );

    const error = await synthesize().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status, code });
    expect((error as Error).message).not.toContain("sensitive upstream detail");
    expect(console.warn).toHaveBeenCalledWith(
      expect.not.stringContaining(baseInput.apiKey),
    );
  });

  it.each([
    {
      label: "network failures",
      error: new Error("sensitive socket detail"),
      status: 502,
      code: "provider_error",
    },
    {
      label: "timeouts",
      error: new DOMException("timed out", "TimeoutError"),
      status: 504,
      code: "timeout",
    },
  ])("maps $label without leaking provider details", async ({ error, status, code }) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

    const caught = await synthesize().catch((caught: unknown) => caught);

    expect(caught).toMatchObject({ status, code });
    expect((caught as Error).message).not.toContain("sensitive socket detail");
    expect(console.warn).toHaveBeenCalledWith(
      expect.not.stringContaining(baseInput.apiKey),
    );
  });

  it("rejects a successful response that is not MP3 audio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ secret: "upstream-secret" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const error = await synthesize().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 502, code: "invalid_audio" });
    expect((error as Error).message).not.toContain("upstream-secret");
  });

  it("rejects an empty MP3 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(audioResponse("audio/mpeg", [])),
    );

    await expect(synthesize()).rejects.toMatchObject({
      status: 502,
      code: "empty_audio",
    });
  });
});
