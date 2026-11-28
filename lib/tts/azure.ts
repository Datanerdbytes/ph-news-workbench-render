import {
  reserveTtsQuota,
  TtsError,
  type TtsSynthesisResult,
} from "./shared";
import {
  ANGELO_NEWS_VOICE_ID,
  buildAngeloNewsSSML,
} from "./angelo";
import {
  getTtsVoice,
  MAX_TTS_SPEED,
  MIN_TTS_SPEED,
  type TtsVoiceId,
} from "./voices";

export { TtsError } from "./shared";
export type { TtsSynthesisResult } from "./shared";

const TIMEOUT_MS = 60_000;
// The news-anchor voice gets the broadcast bitrate; every other voice keeps
// the original high-fidelity format.
const BROADCAST_OUTPUT_FORMAT = "audio-24khz-96kbitrate-mono-mp3";
const DEFAULT_OUTPUT_FORMAT = "audio-48khz-192kbitrate-mono-mp3";

function speechEndpoint(): { key: string; url: string } {
  const key = process.env.AZURE_SPEECH_KEY?.trim();
  const region = process.env.AZURE_SPEECH_REGION?.trim();
  if (!key || !region) {
    throw new TtsError(
      503,
      "not_configured",
      "Voice-over is not configured. Add AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.",
    );
  }
  if (!/^[a-z0-9-]+$/i.test(region)) {
    throw new TtsError(503, "not_configured", "AZURE_SPEECH_REGION is invalid.");
  }

  const configured = process.env.AZURE_SPEECH_ENDPOINT?.trim();
  const base = configured || `https://${region}.tts.speech.microsoft.com`;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new TtsError(503, "not_configured", "AZURE_SPEECH_ENDPOINT is invalid.");
  }
  if (parsed.protocol !== "https:") {
    throw new TtsError(
      503,
      "not_configured",
      "AZURE_SPEECH_ENDPOINT must use HTTPS.",
    );
  }
  return { key, url: `${base.replace(/\/+$/, "")}/cognitiveservices/v1` };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildTtsSsml(
  text: string,
  voiceId: TtsVoiceId,
  speed: number,
): string {
  const voice = getTtsVoice(voiceId);
  const rate = Math.round((speed - 1) * 100);
  const rateValue = `${rate >= 0 ? "+" : ""}${rate}%`;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voice.locale}"><voice name="${voice.id}"><prosody rate="${rateValue}">${escapeXml(text)}</prosody></voice></speak>`;
}

function providerError(status: number): TtsError {
  if (status === 429) {
    return new TtsError(
      429,
      "rate_limited",
      "The speech service is busy. Please try again shortly.",
    );
  }
  if (status === 401 || status === 403) {
    return new TtsError(
      503,
      "not_configured",
      "Voice-over credentials were rejected. Check the Azure Speech configuration.",
    );
  }
  if (status === 400) {
    return new TtsError(
      502,
      "speech_rejected",
      "The speech service could not read this draft. Edit it and try again.",
    );
  }
  return new TtsError(
    502,
    "provider_error",
    "The speech service is unavailable. Please try again shortly.",
  );
}

export async function synthesizeSpeech(input: {
  text: string;
  voiceId: TtsVoiceId;
  speed: number;
  workspaceId: string;
  correlationId: string;
}): Promise<TtsSynthesisResult> {
  if (
    !Number.isFinite(input.speed) ||
    input.speed < MIN_TTS_SPEED ||
    input.speed > MAX_TTS_SPEED
  ) {
    throw new TtsError(400, "invalid_speed", "The speaking speed is invalid.");
  }

  const { key, url } = speechEndpoint();
  // Only the news-anchor voice gets the broadcast SSML treatment; every other
  // voice keeps the generic per-voice markup.
  const isNewsAnchor = input.voiceId === ANGELO_NEWS_VOICE_ID;
  const ssml = isNewsAnchor
    ? buildAngeloNewsSSML(input.text, { speed: input.speed })
    : buildTtsSsml(input.text, input.voiceId, input.speed);
  const outputFormat = isNewsAnchor
    ? BROADCAST_OUTPUT_FORMAT
    : DEFAULT_OUTPUT_FORMAT;
  await reserveTtsQuota(input.workspaceId, input.text.length);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/ssml+xml",
        "Ocp-Apim-Subscription-Key": key,
        "X-Microsoft-OutputFormat": outputFormat,
        "User-Agent": "PH-News-Workbench/1.0",
      },
      body: ssml,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    console.warn(
      JSON.stringify({
        route: "tts",
        event: "provider_request_failed",
        correlationId: input.correlationId,
        timedOut,
      }),
    );
    throw new TtsError(
      timedOut ? 504 : 502,
      timedOut ? "timeout" : "provider_error",
      timedOut
        ? "The speech service took too long. Please try again."
        : "The speech service could not be reached. Please try again.",
    );
  }

  if (!response.ok) {
    console.warn(
      JSON.stringify({
        route: "tts",
        event: "provider_rejected",
        correlationId: input.correlationId,
        status: response.status,
      }),
    );
    throw providerError(response.status);
  }

  const audio = await response.arrayBuffer();
  if (audio.byteLength === 0) {
    throw new TtsError(
      502,
      "empty_audio",
      "The speech service returned no audio. Please try again.",
    );
  }
  return {
    audio,
    voiceId: input.voiceId,
    characters: input.text.length,
  };
}
