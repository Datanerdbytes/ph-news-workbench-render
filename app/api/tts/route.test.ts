import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireWorkspaceMock, synthesizeWorkspaceSpeechMock } = vi.hoisted(() => ({
  requireWorkspaceMock: vi.fn(),
  synthesizeWorkspaceSpeechMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));
vi.mock("@/lib/session", () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () =>
    new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
}));
vi.mock("@/lib/tts/synthesize", () => ({
  synthesizeWorkspaceSpeech: synthesizeWorkspaceSpeechMock,
}));

import { TtsError } from "@/lib/tts/shared";
import { POST } from "./route";

const access = {
  user: { id: "u1" },
  workspace: {
    id: "ws1",
    ttsProvider: "azure" as const,
    assemblyAiVoiceIds: [],
  },
};
const assemblyAiAccess = {
  user: { id: "u1" },
  workspace: {
    id: "ws1",
    ttsProvider: "assemblyai" as const,
    assemblyAiVoiceIds: [],
  },
};
const assemblyAiClonedAccess = {
  user: { id: "u1" },
  workspace: {
    id: "ws1",
    ttsProvider: "assemblyai" as const,
    assemblyAiVoiceIds: ["cloned-voice-id"],
  },
};

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
  synthesizeWorkspaceSpeechMock.mockResolvedValue({
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
    expect(synthesizeWorkspaceSpeechMock).not.toHaveBeenCalled();
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
    expect(synthesizeWorkspaceSpeechMock).not.toHaveBeenCalled();
  });

  it("rejects empty narration and unsupported voices", async () => {
    const empty = await post({ text: "** **", voiceId: "en-PH-RosaNeural" });
    expect(empty.status).toBe(400);
    expect((await empty.json()).code).toBe("empty_text");

    const voice = await post({ text: "Hello", voiceId: "not-a-voice" });
    expect(voice.status).toBe(400);
    expect((await voice.json()).code).toBe("invalid_voice");
    expect(synthesizeWorkspaceSpeechMock).not.toHaveBeenCalled();
  });

  it("rejects out-of-range Azure speaking speeds", async () => {
    const res = await post({
      text: "Hello",
      voiceId: "en-PH-RosaNeural",
      speed: 2,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_speed");
    expect(synthesizeWorkspaceSpeechMock).not.toHaveBeenCalled();
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
    expect(res.headers.get("x-tts-provider")).toBe("azure");
    expect(res.headers.get("x-tts-voice")).toBe("en-PH-RosaNeural");
    expect(res.headers.get("x-tts-characters")).toBe("12");
    expect(res.headers.get("x-correlation-id")).toEqual(expect.any(String));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(synthesizeWorkspaceSpeechMock).toHaveBeenCalledWith({
      workspace: {
        id: "ws1",
        ttsProvider: "azure",
        assemblyAiVoiceIds: [],
      },
      text: "Read this now.",
      voiceId: "en-PH-RosaNeural",
      speed: 1.1,
      correlationId: expect.any(String),
    });
  });

  it("ignores client provider overrides and keeps Azure language support", async () => {
    const res = await post({
      text: "Magandang araw.",
      voiceId: "fil-PH-BlessicaNeural",
      language: "tl",
      speed: 1.1,
      ttsProvider: "assemblyai",
      provider: "assemblyai",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-tts-provider")).toBe("azure");
    expect(synthesizeWorkspaceSpeechMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: {
        id: "ws1",
        ttsProvider: "azure",
        assemblyAiVoiceIds: [],
      },
        voiceId: "fil-PH-BlessicaNeural",
      }),
    );
  });

  it("uses the workspace AssemblyAI provider and returns its response header", async () => {
    requireWorkspaceMock.mockResolvedValue(assemblyAiAccess);
    synthesizeWorkspaceSpeechMock.mockResolvedValue({
      audio: new Uint8Array([4, 5, 6]).buffer,
      voiceId: "aai-kyla",
      characters: 5,
    });

    const res = await post({
      text: "Hello",
      voiceId: "aai-kyla",
      language: "en",
      ttsProvider: "azure",
      provider: "azure",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-tts-provider")).toBe("assemblyai");
    expect(res.headers.get("x-tts-voice")).toBe("aai-kyla");
    expect(res.headers.get("x-tts-characters")).toBe("5");
    expect(synthesizeWorkspaceSpeechMock).toHaveBeenCalledWith({
      workspace: {
        id: "ws1",
        ttsProvider: "assemblyai",
        assemblyAiVoiceIds: [],
      },
      text: "Hello",
      voiceId: "aai-kyla",
      speed: 1,
      correlationId: expect.any(String),
    });
  });

  it("accepts a workspace-configured AssemblyAI cloned voice", async () => {
    requireWorkspaceMock.mockResolvedValue(assemblyAiClonedAccess);
    synthesizeWorkspaceSpeechMock.mockResolvedValue({
      audio: new Uint8Array([4, 5, 6]).buffer,
      voiceId: "cloned-voice-id",
      characters: 5,
    });

    const res = await post({
      text: "Hello",
      voiceId: "cloned-voice-id",
      language: "en",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-tts-voice")).toBe("cloned-voice-id");
    expect(synthesizeWorkspaceSpeechMock).toHaveBeenCalledWith({
      workspace: {
        id: "ws1",
        ttsProvider: "assemblyai",
        assemblyAiVoiceIds: ["cloned-voice-id"],
      },
      text: "Hello",
      voiceId: "cloned-voice-id",
      speed: 1,
      correlationId: expect.any(String),
    });
  });

  it("rejects a cloned voice that is not configured for the workspace", async () => {
    requireWorkspaceMock.mockResolvedValue(assemblyAiAccess);

    const res = await post({
      text: "Hello",
      voiceId: "cloned-voice-id",
      language: "en",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_voice");
    expect(synthesizeWorkspaceSpeechMock).not.toHaveBeenCalled();
  });

  it.each(["tl", "fil", "en-US", undefined, null])(
    "rejects AssemblyAI language %j before synthesis",
    async (language) => {
      requireWorkspaceMock.mockResolvedValue(assemblyAiAccess);

      const res = await post({
        text: "Hello",
        voiceId: "aai-kyla",
        language,
      });

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("unsupported_language");
      expect(synthesizeWorkspaceSpeechMock).not.toHaveBeenCalled();
    },
  );

  it.each([0.75, 1.1, 1.25, 2])(
    "rejects AssemblyAI speed %s before synthesis",
    async (speed) => {
      requireWorkspaceMock.mockResolvedValue(assemblyAiAccess);

      const res = await post({
        text: "Hello",
        voiceId: "aai-kyla",
        language: "en",
        speed,
      });

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("fixed_speed");
      expect(synthesizeWorkspaceSpeechMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an Azure voice when AssemblyAI is selected", async () => {
    requireWorkspaceMock.mockResolvedValue(assemblyAiAccess);

    const res = await post({
      text: "Hello",
      voiceId: "en-PH-RosaNeural",
      language: "en",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_voice");
    expect(synthesizeWorkspaceSpeechMock).not.toHaveBeenCalled();
  });

  it("maps provider errors to a safe JSON envelope", async () => {
    synthesizeWorkspaceSpeechMock.mockRejectedValue(
      new TtsError(
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
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      code: "rate_limited",
      correlationId: expect.any(String),
    });
  });
});
