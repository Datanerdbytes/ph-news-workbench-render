import { isVoiceForProvider } from "./providers";
import { reserveTtsQuota, TtsError, type TtsSynthesisResult } from "./shared";

const ENDPOINT = "https://tts.us.assemblyai.com/v1/speech";
const TIMEOUT_MS = 60_000;

function providerError(status: number): TtsError {
  if (status === 401) {
    return new TtsError(
      503,
      "not_configured",
      "AssemblyAI credentials were rejected. Check the saved API key in Settings.",
    );
  }
  if (status === 403) {
    return new TtsError(
      403,
      "voice_access_denied",
      "AssemblyAI denied access to this voice. Check the voice ID and accept any required biometric terms in AssemblyAI.",
    );
  }
  if (status === 402) {
    return new TtsError(
      402,
      "insufficient_credits",
      "The AssemblyAI account does not have enough credit for voice-over.",
    );
  }
  if (status === 422) {
    return new TtsError(
      400,
      "speech_rejected",
      "AssemblyAI could not use this text or voice. Edit the draft or choose another voice.",
    );
  }
  if (status === 429) {
    return new TtsError(
      429,
      "rate_limited",
      "AssemblyAI is busy. Please try again shortly.",
    );
  }
  return new TtsError(
    502,
    "provider_error",
    "AssemblyAI is unavailable. Please try again shortly.",
  );
}

export async function synthesizeAssemblyAiSpeech(input: {
  text: string;
  voiceId: string;
  speed: number;
  apiKey: string;
  clonedVoiceIds: readonly string[];
  workspaceId: string;
  correlationId: string;
}): Promise<TtsSynthesisResult> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new TtsError(
      503,
      "not_configured",
      "AssemblyAI is not configured. Add an API key in Settings.",
    );
  }
  if (!isVoiceForProvider(input.voiceId, "assemblyai", input.clonedVoiceIds)) {
    throw new TtsError(400, "invalid_voice", "Choose a supported AssemblyAI voice.");
  }
  if (input.speed !== 1) {
    throw new TtsError(
      400,
      "fixed_speed",
      "AssemblyAI voice-over uses natural speaking speed.",
    );
  }

  await reserveTtsQuota(input.workspaceId, input.text.length);

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
        "User-Agent": "PH-News-Workbench/1.0",
        "X-Client-Request-Id": input.correlationId,
      },
      body: JSON.stringify({
        text: input.text,
        voice_id: input.voiceId,
        language: "english",
        encoding: "mp3",
        bit_rate: 64000,
        stream: false,
        speed: 1,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    console.warn(
      JSON.stringify({
        route: "tts",
        event: "provider_request_failed",
        provider: "assemblyai",
        correlationId: input.correlationId,
        timedOut,
      }),
    );
    throw new TtsError(
      timedOut ? 504 : 502,
      timedOut ? "timeout" : "provider_error",
      timedOut
        ? "AssemblyAI took too long. Please try again."
        : "AssemblyAI could not be reached. Please try again.",
    );
  }

  if (!response.ok) {
    console.warn(
      JSON.stringify({
        route: "tts",
        event: "provider_rejected",
        provider: "assemblyai",
        correlationId: input.correlationId,
        status: response.status,
      }),
    );
    throw providerError(response.status);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("audio/mpeg") && !contentType.includes("audio/mp3")) {
    throw new TtsError(
      502,
      "invalid_audio",
      "AssemblyAI did not return voice-over audio. Please try again.",
    );
  }

  const audio = await response.arrayBuffer();
  if (audio.byteLength === 0) {
    throw new TtsError(
      502,
      "empty_audio",
      "AssemblyAI returned no audio. Please try again.",
    );
  }
  return {
    audio,
    voiceId: input.voiceId,
    characters: input.text.length,
  };
}
