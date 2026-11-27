import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireWorkspaceMock, synthesizeSpeechMock } = vi.hoisted(() => ({
  requireWorkspaceMock: vi.fn(),
  synthesizeSpeechMock: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () =>
    new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
}));

vi.mock("@/lib/tts/azure", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tts/azure")>();
  return { ...actual, synthesizeSpeech: synthesizeSpeechMock };
});

import { POST } from "./route";

const access = { user: { id: "u1" }, workspace: { id: "ws1" } };

function post(body: unknown = {}) {
  return POST(
    new Request("http://localhost/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireWorkspaceMock.mockResolvedValue(access);
  synthesizeSpeechMock.mockResolvedValue({
    audio: new Uint8Array([1, 2, 3]).buffer,
    voiceId: "en-PH-RosaNeural",
    characters: 12,
  });
});

describe("POST /api/tts", () => {
  it("requires a workspace session", async () => {
    requireWorkspaceMock.mockResolvedValue(null);
    const res = await post({
      text: "Hello",
      voiceId: "en-PH-RosaNeural",
      speed: 1,
    });
    expect(res.status).toBe(401);
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_json");
  });

  it("rejects empty narration and unsupported voices", async () => {
    const empty = await post({ text: "** **", voiceId: "en-PH-RosaNeural" });
    expect(empty.status).toBe(400);
    expect((await empty.json()).code).toBe("empty_text");

    const voice = await post({ text: "Hello", voiceId: "not-a-voice" });
    expect(voice.status).toBe(400);
    expect((await voice.json()).code).toBe("invalid_voice");
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("rejects out-of-range speaking speeds", async () => {
    const res = await post({
      text: "Hello",
      voiceId: "en-PH-RosaNeural",
      speed: 2,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_speed");
  });

  it("normalizes the draft and returns non-cacheable MP3 audio", async () => {
    const res = await post({
      text: "**Read** [this](https://example.com) now.",
      voiceId: "en-PH-RosaNeural",
      speed: 1.1,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(synthesizeSpeechMock).toHaveBeenCalledWith({
      text: "Read this now.",
      voiceId: "en-PH-RosaNeural",
      speed: 1.1,
      workspaceId: "ws1",
      correlationId: expect.any(String),
    });
  });

  it("maps provider errors to a safe JSON envelope", async () => {
    synthesizeSpeechMock.mockRejectedValue(
      new (await import("@/lib/tts/azure")).TtsError(
        429,
        "rate_limited",
        "The speech service is busy. Please try again shortly.",
      ),
    );

    const res = await post({
      text: "Hello",
      voiceId: "en-PH-RosaNeural",
      speed: 1,
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      code: "rate_limited",
      correlationId: expect.any(String),
    });
  });
});
