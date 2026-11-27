import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getAvatar, isAvatarId } from "@/lib/avatar/avatars";
import { avatarLimits, estimateAvatarSeconds } from "@/lib/avatar/config";
import {
  ACTIVE_AVATAR_STATUSES,
  publicAvatarJob,
  type AvatarJobRow,
} from "@/lib/avatar/jobs";
import {
  AvatarQueueError,
  enqueueAvatarJob,
} from "@/lib/avatar/queue";
import { AvatarError, avatarEndpoint } from "@/lib/avatar/azure";
import { sql } from "@/lib/db";
import { requireWorkspace, unauthorized } from "@/lib/session";
import { normalizeSpeechText } from "@/lib/tts/text";
import {
  isTtsVoiceId,
  MAX_TTS_SPEED,
  MIN_TTS_SPEED,
} from "@/lib/tts/voices";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function failure(status: number, code: string, error: string, correlationId: string) {
  return NextResponse.json(
    { error, code, correlationId },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();
  const rows = await sql`
    SELECT * FROM avatar_jobs
    WHERE workspace_id = ${access.workspace.id}
    ORDER BY (status = ANY(${ACTIVE_AVATAR_STATUSES}::text[])) DESC, created_at DESC
    LIMIT 10`;
  return NextResponse.json((rows as unknown as AvatarJobRow[]).map(publicAvatarJob), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();
  const correlationId = randomUUID();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure(400, "invalid_json", "Invalid JSON body.", correlationId);
  }
  if (!body || typeof body !== "object") {
    return failure(400, "invalid_body", "Invalid request body.", correlationId);
  }
  const payload = body as Record<string, unknown>;
  if (typeof payload.text !== "string") {
    return failure(400, "invalid_text", "Draft text is required.", correlationId);
  }
  const text = normalizeSpeechText(payload.text);
  if (!text) {
    return failure(400, "empty_text", "Write a draft before generating an avatar.", correlationId);
  }
  const limits = avatarLimits();
  if (text.length > limits.maxCharacters) {
    return failure(
      400,
      "text_too_long",
      `Avatar narration is limited to ${limits.maxCharacters} characters.`,
      correlationId,
    );
  }
  if (!isAvatarId(payload.avatarId)) {
    return failure(400, "invalid_avatar", "Choose a supported avatar.", correlationId);
  }
  const avatar = getAvatar(payload.avatarId);
  if (avatar.kind === "photo" && avatar.baseModel !== "vasa-1") {
    return failure(
      400,
      "avatar_unavailable",
      "This preview avatar requires Azure real-time synthesis. Choose another photo avatar.",
      correlationId,
    );
  }
  if (payload.transparent !== undefined && typeof payload.transparent !== "boolean") {
    return failure(400, "invalid_transparency", "Choose a valid background setting.", correlationId);
  }
  const transparent = payload.transparent === true;
  if (transparent && avatar.kind !== "video") {
    return failure(
      400,
      "transparency_unavailable",
      "Transparent backgrounds are available for Meg and Max only.",
      correlationId,
    );
  }
  if (!isTtsVoiceId(payload.voiceId)) {
    return failure(400, "invalid_voice", "Choose a supported voice.", correlationId);
  }
  const speed = payload.speed === undefined ? 1 : payload.speed;
  if (
    typeof speed !== "number" ||
    !Number.isFinite(speed) ||
    speed < MIN_TTS_SPEED ||
    speed > MAX_TTS_SPEED
  ) {
    return failure(400, "invalid_speed", "Speaking speed must be between 0.75 and 1.25.", correlationId);
  }
  if (estimateAvatarSeconds(text, speed) > limits.maxJobSeconds) {
    return failure(
      400,
      "text_too_long",
      `This narration may exceed the ${Math.round(limits.maxJobSeconds / 60)}-minute avatar limit.`,
      correlationId,
    );
  }

  try {
    avatarEndpoint();
    const job = await enqueueAvatarJob({
      workspaceId: access.workspace.id,
      userId: access.user.id,
      avatarId: payload.avatarId,
      voiceId: payload.voiceId,
      speed,
      text,
      transparent,
    });
    return NextResponse.json(publicAvatarJob(job), {
      status: 202,
      headers: { "Cache-Control": "no-store", "X-Correlation-Id": correlationId },
    });
  } catch (error) {
    if (error instanceof AvatarQueueError || error instanceof AvatarError) {
      return failure(error.status, error.code, error.message, correlationId);
    }
    console.error(JSON.stringify({ route: "avatar-syntheses", event: "unexpected_error", correlationId }));
    return failure(500, "internal_error", "The avatar job could not be created.", correlationId);
  }
}
