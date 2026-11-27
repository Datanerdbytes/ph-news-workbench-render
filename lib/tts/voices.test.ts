import { describe, expect, it } from "vitest";
import {
  MAX_TTS_SPEED,
  MIN_TTS_SPEED,
  TTS_VOICES,
  defaultVoiceForLanguage,
  getTtsVoice,
  isTtsVoiceId,
} from "./voices";

describe("voice catalog", () => {
  it("recognizes only catalog ids", () => {
    expect(isTtsVoiceId("en-PH-RosaNeural")).toBe(true);
    expect(isTtsVoiceId("fil-PH-BlessicaNeural")).toBe(true);
    expect(isTtsVoiceId("en-US-AvaMultilingualNeural")).toBe(true);
    expect(isTtsVoiceId("en-US-ChristopherNeural")).toBe(true);
    expect(isTtsVoiceId("en-US-JennyNeural")).toBe(false);
    expect(isTtsVoiceId(undefined)).toBe(false);
  });

  it("returns the catalog entry for a known id", () => {
    expect(getTtsVoice("fil-PH-AngeloNeural")).toMatchObject({
      id: "fil-PH-AngeloNeural",
      locale: "fil-PH",
      language: "tl",
    });
    expect(getTtsVoice("en-PH-JamesNeural")).toMatchObject({ gender: "Male" });
    expect(getTtsVoice("en-US-AvaMultilingualNeural")).toMatchObject({
      locale: "en-US",
      language: "en",
      label: "English (US)",
      name: "Ava",
    });
    expect(getTtsVoice("en-US-ChristopherNeural")).toMatchObject({
      locale: "en-US",
      language: "en",
      label: "English (US)",
      name: "Christopher",
      gender: "Male",
    });
  });

  it("picks a default voice per language", () => {
    expect(defaultVoiceForLanguage("tl")).toBe("fil-PH-BlessicaNeural");
    expect(defaultVoiceForLanguage("en")).toBe("en-PH-RosaNeural");
    expect(isTtsVoiceId(defaultVoiceForLanguage("tl"))).toBe(true);
    expect(isTtsVoiceId(defaultVoiceForLanguage("en"))).toBe(true);
  });

  it("keeps every voice in the catalog", () => {
    expect(TTS_VOICES.length).toBeGreaterThan(0);
    for (const voice of TTS_VOICES) {
      expect(isTtsVoiceId(voice.id)).toBe(true);
    }
  });

  it("bounds the playback speed", () => {
    expect(MIN_TTS_SPEED).toBeLessThan(MAX_TTS_SPEED);
    expect(MIN_TTS_SPEED).toBeGreaterThan(0);
    expect(MAX_TTS_SPEED).toBeGreaterThan(1);
  });
});
