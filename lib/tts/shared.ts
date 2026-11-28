import { sql } from "@/lib/db";

export class TtsError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

export type TtsSynthesisResult = {
  audio: ArrayBuffer;
  voiceId: string;
  characters: number;
};

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export async function reserveTtsQuota(
  workspaceId: string,
  characters: number,
): Promise<void> {
  const requestCap = positiveInteger("TTS_DAILY_REQUEST_CAP", 25);
  const characterCap = positiveInteger("TTS_DAILY_CHARACTER_CAP", 100_000);
  if (characters > characterCap) {
    throw new TtsError(
      429,
      "quota_exceeded",
      "This voice-over exceeds the daily character allowance. Try a shorter draft.",
    );
  }

  const day = new Date().toISOString().slice(0, 10);
  const rows = (await sql`
    INSERT INTO tts_usage_daily (day, workspace_id, requests, characters)
    VALUES (${day}, ${workspaceId}, 1, ${characters})
    ON CONFLICT (day, workspace_id) DO UPDATE
    SET requests = tts_usage_daily.requests + 1,
        characters = tts_usage_daily.characters + ${characters}
    WHERE tts_usage_daily.requests < ${requestCap}
      AND tts_usage_daily.characters + ${characters} <= ${characterCap}
    RETURNING requests, characters`) as unknown as Array<{
    requests: number;
    characters: number;
  }>;

  if (!rows.length) {
    throw new TtsError(
      429,
      "quota_exceeded",
      "The daily voice-over allowance is used up. Try again tomorrow.",
    );
  }
}
