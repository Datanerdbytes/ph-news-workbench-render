import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const { sqlMock, synthesizeAssemblyAiSpeechMock, synthesizeSpeechMock } =
  vi.hoisted(() => ({
    sqlMock: vi.fn(),
    synthesizeAssemblyAiSpeechMock: vi.fn(),
    synthesizeSpeechMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({ sql: sqlMock }));
vi.mock("@/lib/tts/assemblyai", () => ({
  synthesizeAssemblyAiSpeech: synthesizeAssemblyAiSpeechMock,
}));
vi.mock("@/lib/tts/azure", () => ({
  synthesizeSpeech: synthesizeSpeechMock,
}));

import { encryptAssemblyAiKey } from "@/lib/facebook-token";
import { synthesizeWorkspaceSpeech } from "./synthesize";

const sql = sqlMock as unknown as Mock;
const result = {
  audio: new Uint8Array([1, 2, 3]).buffer,
  voiceId: "provider-voice",
  characters: 12,
};
const baseInput = {
  workspace: {
    id: "ws1",
    ttsProvider: "azure" as const,
    assemblyAiVoiceIds: [],
  },
  text: "Hello there.",
  voiceId: "en-PH-RosaNeural",
  speed: 1,
  correlationId: "corr-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  sql.mockReset();
  vi.stubEnv("BETTER_AUTH_SECRET", "workspace-tts-test-secret");
  synthesizeAssemblyAiSpeechMock.mockResolvedValue(result);
  synthesizeSpeechMock.mockResolvedValue(result);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("synthesizeWorkspaceSpeech", () => {
  it("dispatches Azure directly without reading an AssemblyAI key", async () => {
    await expect(synthesizeWorkspaceSpeech(baseInput)).resolves.toBe(result);

    expect(synthesizeSpeechMock).toHaveBeenCalledWith({
      text: baseInput.text,
      voiceId: baseInput.voiceId,
      speed: baseInput.speed,
      workspaceId: "ws1",
      correlationId: "corr-1",
    });
    expect(synthesizeAssemblyAiSpeechMock).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it("loads the selected workspace key and dispatches its decrypted value", async () => {
    const encryptedKey = encryptAssemblyAiKey("saved-assemblyai-key");
    sql.mockResolvedValue([{ assemblyai_api_key_encrypted: encryptedKey }]);

    await expect(
      synthesizeWorkspaceSpeech({
        ...baseInput,
        workspace: {
          id: "ws-assemblyai",
          ttsProvider: "assemblyai",
          assemblyAiVoiceIds: ["cloned-voice-id"],
        },
        voiceId: "aai-kyla",
      }),
    ).resolves.toBe(result);

    expect(sql).toHaveBeenCalledTimes(1);
    expect(sql.mock.calls[0][0].join(" ")).toContain(
      "SELECT assemblyai_api_key_encrypted",
    );
    expect(sql.mock.calls[0].slice(1)).toEqual(["ws-assemblyai"]);
    expect(synthesizeAssemblyAiSpeechMock).toHaveBeenCalledWith({
      text: baseInput.text,
      voiceId: "aai-kyla",
      speed: 1,
      apiKey: "saved-assemblyai-key",
      clonedVoiceIds: ["cloned-voice-id"],
      workspaceId: "ws-assemblyai",
      correlationId: "corr-1",
    });
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("fails safely when AssemblyAI is selected without a saved key", async () => {
    sql.mockResolvedValue([{ assemblyai_api_key_encrypted: null }]);

    await expect(
      synthesizeWorkspaceSpeech({
        ...baseInput,
        workspace: {
          id: "ws1",
          ttsProvider: "assemblyai",
          assemblyAiVoiceIds: [],
        },
        voiceId: "aai-kyla",
      }),
    ).rejects.toMatchObject({ status: 503, code: "not_configured" });
    expect(synthesizeAssemblyAiSpeechMock).not.toHaveBeenCalled();
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("fails safely when the saved AssemblyAI key cannot be decrypted", async () => {
    const encryptedKey = "v1.unreadable.ciphertext.payload";
    sql.mockResolvedValue([{ assemblyai_api_key_encrypted: encryptedKey }]);

    const error = await synthesizeWorkspaceSpeech({
      ...baseInput,
      workspace: {
        id: "ws1",
        ttsProvider: "assemblyai",
        assemblyAiVoiceIds: [],
      },
      voiceId: "aai-kyla",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 503, code: "not_configured" });
    expect((error as Error).message).not.toContain(encryptedKey);
    expect(synthesizeAssemblyAiSpeechMock).not.toHaveBeenCalled();
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it("rejects an AssemblyAI voice on the Azure path", async () => {
    await expect(
      synthesizeWorkspaceSpeech({ ...baseInput, voiceId: "aai-kyla" }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_voice" });

    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
    expect(synthesizeAssemblyAiSpeechMock).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });
});
