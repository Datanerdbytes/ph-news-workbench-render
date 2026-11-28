import {
  defaultVoiceForLanguage,
  TTS_VOICES,
} from "./voices";

export const TTS_PROVIDERS = [
  {
    id: "azure",
    label: "Azure Speech",
    detail: "English and Filipino voices with adjustable speaking speed.",
  },
  {
    id: "assemblyai",
    label: "AssemblyAI",
    detail: "English and cloned voices at natural speed. Filipino is not supported.",
  },
] as const;

export type TtsProviderId = (typeof TTS_PROVIDERS)[number]["id"];

export const DEFAULT_TTS_PROVIDER: TtsProviderId = "azure";

export type SpeechVoice = {
  readonly id: string;
  readonly locale: string;
  readonly language: "en" | "tl";
  readonly label: string;
  readonly name: string;
  readonly gender: string;
  readonly cloned?: boolean;
};

export const MAX_ASSEMBLYAI_CLONED_VOICES = 20;
export const MAX_ASSEMBLYAI_VOICE_ID_LENGTH = 64;

export const ASSEMBLYAI_TTS_VOICES = [
  {
    id: "aai-kyla",
    locale: "en-US",
    language: "en",
    label: "English (US)",
    name: "Kyla",
    gender: "Female",
  },
  {
    id: "aai-aaliyah",
    locale: "en-US",
    language: "en",
    label: "English (US)",
    name: "Aaliyah",
    gender: "Female",
  },
  {
    id: "aai-peter",
    locale: "en-US",
    language: "en",
    label: "English (US)",
    name: "Peter",
    gender: "Male",
  },
  {
    id: "aai-titus",
    locale: "en-US",
    language: "en",
    label: "English (US)",
    name: "Titus",
    gender: "Male",
  },
] as const satisfies readonly SpeechVoice[];

export function normalizeAssemblyAiVoiceIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ASSEMBLYAI_CLONED_VOICES) {
    return null;
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const id = entry.trim();
    if (
      !id ||
      id.length > MAX_ASSEMBLYAI_VOICE_ID_LENGTH ||
      /[\s\u0000-\u001f\u007f]/.test(id)
    ) {
      return null;
    }
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  return ids;
}

export function readAssemblyAiVoiceIds(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return normalizeAssemblyAiVoiceIds(parsed) ?? [];
}

export function isTtsProviderId(value: unknown): value is TtsProviderId {
  return TTS_PROVIDERS.some((provider) => provider.id === value);
}

export function ttsProviderLabel(value: TtsProviderId): string {
  return TTS_PROVIDERS.find((provider) => provider.id === value)?.label ?? value;
}

export function voicesForProvider(
  provider: TtsProviderId,
  clonedVoiceIds: readonly string[] = [],
): readonly SpeechVoice[] {
  if (provider !== "assemblyai") return TTS_VOICES;
  const builtInIds = new Set<string>(ASSEMBLYAI_TTS_VOICES.map((voice) => voice.id));
  const clonedIds = (normalizeAssemblyAiVoiceIds(clonedVoiceIds) ?? []).filter(
    (id) => !builtInIds.has(id.toLowerCase()),
  );
  return [
    ...ASSEMBLYAI_TTS_VOICES,
    ...clonedIds.map((id) => ({
      id,
      locale: "en-US",
      language: "en" as const,
      label: "Cloned",
      name: id,
      gender: "Custom",
      cloned: true,
    })),
  ];
}

export function isVoiceForProvider(
  value: unknown,
  provider: TtsProviderId,
  clonedVoiceIds: readonly string[] = [],
): value is string {
  return voicesForProvider(provider, clonedVoiceIds).some(
    (voice) => voice.id === value,
  );
}

export function defaultVoiceForProvider(
  provider: TtsProviderId,
  language: "en" | "tl" = "en",
): string {
  return provider === "assemblyai"
    ? ASSEMBLYAI_TTS_VOICES[0].id
    : defaultVoiceForLanguage(language);
}

export function providerSupportsLanguage(
  provider: TtsProviderId,
  language: "en" | "tl",
): boolean {
  return provider === "azure" || language === "en";
}

export function providerSupportsSpeed(provider: TtsProviderId): boolean {
  return provider === "azure";
}
