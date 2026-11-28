import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireWorkspace, unauthorized } from "@/lib/session";
import { normalizeSpeechText, MAX_TTS_CHARACTERS } from "@/lib/tts/text";
import {
  DEFAULT_TTS_PROVIDER,
  isVoiceForProvider,
  providerSupportsSpeed,
} from "@/lib/tts/providers";
import { synthesizeWorkspaceSpeech } from "@/lib/tts/synthesize";
import { TtsError } from "@/lib/tts/shared";
import {
  MAX_TTS_SPEED,
  MIN_TTS_SPEED,
} from "@/lib/tts/voices";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(
  status: number,
  code: string,
  error: string,
  correlationId: string,
) {
  return NextResponse.json(
    { error, code, correlationId },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();
  const correlationId = randomUUID();
  const provider = access.workspace.ttsProvider ?? DEFAULT_TTS_PROVIDER;
  const clonedVoiceIds = access.workspace.assemblyAiVoiceIds ?? [];

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "Invalid JSON body.", correlationId);
  }
  if (!body || typeof body !== "object") {
    return errorResponse(400, "invalid_body", "Invalid request body.", correlationId);
  }

  const payload = body as Record<string, unknown>;
  if (typeof payload.text !== "string") {
    return errorResponse(400, "invalid_text", "Draft text is required.", correlationId);
  }
  const text = normalizeSpeechText(payload.text);
  if (!text) {
    return errorResponse(
      400,
      "empty_text",
      "Write a draft before generating voice-over.",
      correlationId,
    );
  }
  if (text.length > MAX_TTS_CHARACTERS) {
    return errorResponse(
      400,
      "text_too_long",
      `Voice-over text is limited to ${MAX_TTS_CHARACTERS} characters.`,
      correlationId,
    );
  }
  if (provider === "assemblyai" && payload.language !== "en") {
    return errorResponse(
      400,
      "unsupported_language",
      "AssemblyAI supports English voice-over only. Switch to Azure Speech for Filipino or Tagalog.",
      correlationId,
    );
  }
  if (!isVoiceForProvider(payload.voiceId, provider, clonedVoiceIds)) {
    return errorResponse(400, "invalid_voice", "Choose a supported voice.", correlationId);
  }
  const speed = payload.speed === undefined ? 1 : payload.speed;
  if (
    typeof speed !== "number" ||
    !Number.isFinite(speed) ||
    speed < MIN_TTS_SPEED ||
    speed > MAX_TTS_SPEED ||
    (!providerSupportsSpeed(provider) && speed !== 1)
  ) {
    return errorResponse(
      400,
      providerSupportsSpeed(provider) ? "invalid_speed" : "fixed_speed",
      providerSupportsSpeed(provider)
        ? "Speaking speed must be between 0.75 and 1.25."
        : "AssemblyAI voice-over uses natural speaking speed.",
      correlationId,
    );
  }

  try {
    const result = await synthesizeWorkspaceSpeech({
      workspace: {
        id: access.workspace.id,
        ttsProvider: provider,
        assemblyAiVoiceIds: clonedVoiceIds,
      },
      text,
      voiceId: payload.voiceId as string,
      speed,
      correlationId,
    });
    return new Response(result.audio, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": 'inline; filename="narration.mp3"',
        "Cache-Control": "no-store",
        "X-Correlation-Id": correlationId,
        "X-TTS-Provider": provider,
        "X-TTS-Voice": result.voiceId,
        "X-TTS-Characters": String(result.characters),
      },
    });
  } catch (error) {
    if (error instanceof TtsError) {
      return errorResponse(error.status, error.code, error.message, correlationId);
    }
    console.error(
      JSON.stringify({
        route: "tts",
        event: "unexpected_error",
        correlationId,
      }),
    );
    return errorResponse(
      500,
      "internal_error",
      "Voice-over could not be generated. Please try again.",
      correlationId,
    );
  }
}
