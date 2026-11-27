export const TTS_VOICES = [
  {
    id: "fil-PH-BlessicaNeural",
    locale: "fil-PH",
    language: "tl",
    label: "Filipino",
    name: "Blessica",
    gender: "Female",
  },
  {
    id: "fil-PH-AngeloNeural",
    locale: "fil-PH",
    language: "tl",
    label: "Filipino",
    name: "Angelo",
    gender: "Male",
  },
  {
    id: "en-PH-RosaNeural",
    locale: "en-PH",
    language: "en",
    label: "English (PH)",
    name: "Rosa",
    gender: "Female",
  },
  {
    id: "en-PH-JamesNeural",
    locale: "en-PH",
    language: "en",
    label: "English (PH)",
    name: "James",
    gender: "Male",
  },
  {
    id: "en-US-AvaMultilingualNeural",
    locale: "en-US",
    language: "en",
    label: "English (US)",
    name: "Ava",
    gender: "Female",
  },
  {
    id: "en-US-ChristopherNeural",
    locale: "en-US",
    language: "en",
    label: "English (US)",
    name: "Christopher",
    gender: "Male",
  },
] as const;

export type TtsVoice = (typeof TTS_VOICES)[number];
export type TtsVoiceId = TtsVoice["id"];

export const MIN_TTS_SPEED = 0.75;
export const MAX_TTS_SPEED = 1.25;

export function isTtsVoiceId(value: unknown): value is TtsVoiceId {
  return TTS_VOICES.some((voice) => voice.id === value);
}

export function getTtsVoice(voiceId: TtsVoiceId): TtsVoice {
  return TTS_VOICES.find((voice) => voice.id === voiceId)!;
}

export function defaultVoiceForLanguage(language: "en" | "tl"): TtsVoiceId {
  return language === "tl" ? "fil-PH-BlessicaNeural" : "en-PH-RosaNeural";
}
