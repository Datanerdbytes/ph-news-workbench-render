import { MAX_TTS_CHARACTERS } from "@/lib/tts/text";

export const MAX_AVATAR_JOB_SECONDS = 600;
export const MAX_AVATAR_OUTPUT_BYTES = 512 * 1024 * 1024;

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function avatarLimits() {
  return {
    dailyJobs: positiveInteger("AVATAR_DAILY_JOB_CAP", 5),
    dailySeconds: positiveInteger("AVATAR_DAILY_SECONDS_CAP", 1_800),
    maxActive: positiveInteger("AVATAR_MAX_ACTIVE_JOBS", 2),
    apiRequestsPerMinute: positiveInteger("AVATAR_API_REQUESTS_PER_MINUTE", 2),
    maxCharacters: Math.min(
      positiveInteger("AVATAR_MAX_CHARACTERS", MAX_TTS_CHARACTERS),
      MAX_TTS_CHARACTERS,
    ),
    maxJobSeconds: Math.min(
      positiveInteger("AVATAR_MAX_JOB_SECONDS", MAX_AVATAR_JOB_SECONDS),
      MAX_AVATAR_JOB_SECONDS,
    ),
  };
}

export function estimateAvatarSeconds(text: string, speed: number): number {
  return Math.max(3, Math.ceil(text.length / (11 * speed)) + 2);
}

export function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}
