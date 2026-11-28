import { describe, expect, it } from "vitest";
import {
  ASSEMBLYAI_TTS_VOICES,
  DEFAULT_TTS_PROVIDER,
  defaultVoiceForProvider,
  isTtsProviderId,
  isVoiceForProvider,
  MAX_ASSEMBLYAI_CLONED_VOICES,
  normalizeAssemblyAiVoiceIds,
  providerSupportsLanguage,
  providerSupportsSpeed,
  readAssemblyAiVoiceIds,
  TTS_PROVIDERS,
  ttsProviderLabel,
  voicesForProvider,
  type TtsProviderId,
} from "./providers";
import { TTS_VOICES } from "./voices";

describe("TTS provider registry", () => {
  it("registers Azure and AssemblyAI with Azure as the default", () => {
    expect(TTS_PROVIDERS.map((provider) => provider.id)).toEqual([
      "azure",
      "assemblyai",
    ]);
    expect(DEFAULT_TTS_PROVIDER).toBe("azure");
    expect(ttsProviderLabel("azure")).toBe("Azure Speech");
    expect(ttsProviderLabel("assemblyai")).toBe("AssemblyAI");
  });

  it.each(["azure", "assemblyai"])("accepts the %s provider id", (provider) => {
    expect(isTtsProviderId(provider)).toBe(true);
  });

  it.each([undefined, null, "", "openai", "AZURE", 1, {}])(
    "rejects the unsupported provider id %j",
    (provider) => {
      expect(isTtsProviderId(provider)).toBe(false);
    },
  );

  it("keeps provider voices isolated", () => {
    expect(voicesForProvider("azure")).toBe(TTS_VOICES);
    expect(voicesForProvider("assemblyai")).toEqual(ASSEMBLYAI_TTS_VOICES);
    expect(isVoiceForProvider("en-PH-RosaNeural", "azure")).toBe(true);
    expect(isVoiceForProvider("aai-kyla", "assemblyai")).toBe(true);
    expect(isVoiceForProvider("aai-kyla", "azure")).toBe(false);
    expect(isVoiceForProvider("en-PH-RosaNeural", "assemblyai")).toBe(false);
    expect(isVoiceForProvider(undefined, "assemblyai")).toBe(false);
  });

  it("chooses language-aware Azure defaults and an English AssemblyAI default", () => {
    expect(defaultVoiceForProvider("azure", "en")).toBe("en-PH-RosaNeural");
    expect(defaultVoiceForProvider("azure", "tl")).toBe("fil-PH-BlessicaNeural");
    expect(defaultVoiceForProvider("assemblyai")).toBe("aai-kyla");
    expect(defaultVoiceForProvider("assemblyai", "tl")).toBe("aai-kyla");
  });

  it("advertises only Azure for Filipino and adjustable speed", () => {
    expect(providerSupportsLanguage("azure", "en")).toBe(true);
    expect(providerSupportsLanguage("azure", "tl")).toBe(true);
    expect(providerSupportsLanguage("assemblyai", "en")).toBe(true);
    expect(providerSupportsLanguage("assemblyai", "tl")).toBe(false);
    expect(providerSupportsSpeed("azure")).toBe(true);
    expect(providerSupportsSpeed("assemblyai")).toBe(false);
  });

  it("appends configured cloned voices without duplicating built-ins", () => {
    const voices = voicesForProvider("assemblyai", [
      "cloned-voice-id",
      "CLONED-VOICE-ID",
      "aai-kyla",
    ]);

    expect(voices).toHaveLength(ASSEMBLYAI_TTS_VOICES.length + 1);
    expect(voices.at(-1)).toMatchObject({
      id: "cloned-voice-id",
      language: "en",
      cloned: true,
    });
    expect(isVoiceForProvider("cloned-voice-id", "assemblyai", ["cloned-voice-id"])).toBe(true);
    expect(isVoiceForProvider("cloned-voice-id", "assemblyai")).toBe(false);
    expect(isVoiceForProvider("cloned-voice-id", "azure", ["cloned-voice-id"])).toBe(false);
  });

  it("normalizes cloned voice IDs and rejects invalid lists", () => {
    expect(normalizeAssemblyAiVoiceIds([" cloned-one ", "cloned-two", "CLONED-ONE"])).toEqual([
      "cloned-one",
      "cloned-two",
    ]);
    expect(normalizeAssemblyAiVoiceIds([])).toEqual([]);
    expect(normalizeAssemblyAiVoiceIds(["bad id"])).toBeNull();
    expect(normalizeAssemblyAiVoiceIds(["x".repeat(65)])).toBeNull();
    expect(normalizeAssemblyAiVoiceIds([1])).toBeNull();
    expect(
      normalizeAssemblyAiVoiceIds(
        Array.from({ length: MAX_ASSEMBLYAI_CLONED_VOICES + 1 }, (_, index) => `voice-${index}`),
      ),
    ).toBeNull();
  });

  it("reads JSONB or JSON-encoded voice ID lists safely", () => {
    expect(readAssemblyAiVoiceIds(["cloned-voice"])).toEqual(["cloned-voice"]);
    expect(readAssemblyAiVoiceIds('["cloned-voice"]')).toEqual(["cloned-voice"]);
    expect(readAssemblyAiVoiceIds("not-json")).toEqual([]);
    expect(readAssemblyAiVoiceIds({ voice: "cloned-voice" })).toEqual([]);
  });

  it("falls back to the supplied id for an unknown label", () => {
    expect(ttsProviderLabel("future-provider" as TtsProviderId)).toBe(
      "future-provider",
    );
  });
});
