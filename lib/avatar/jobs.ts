import type { AvatarId } from "./avatars";
import type { TtsVoiceId } from "@/lib/tts/voices";

export type AvatarJobStatus =
  | "queued"
  | "submitting"
  | "running"
  | "downloading"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export type AvatarPublishState = "ready" | "publishing" | "scheduled" | "published";

export const ACTIVE_AVATAR_STATUSES: AvatarJobStatus[] = [
  "queued",
  "submitting",
  "running",
  "downloading",
  "finalizing",
];

export type AvatarJobRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  avatar_id: string;
  avatar_kind: string;
  avatar_style: string | null;
  voice_id: string;
  speed: number;
  text: string;
  characters: number;
  estimated_seconds: number;
  provider_synthesis_id: string | null;
  status: AvatarJobStatus;
  progress: number | null;
  status_message: string;
  blob_url: string | null;
  file_size: string | number | null;
  duration_seconds: number | null;
  error: string | null;
  worker_id: string | null;
  attempts: number;
  cancel_requested: boolean;
  publish_state: AvatarPublishState;
  created_at: Date | string;
  updated_at: Date | string;
};

export type PublicAvatarJob = {
  id: string;
  avatarId: AvatarId;
  voiceId: TtsVoiceId;
  speed: number;
  text: string;
  status: AvatarJobStatus;
  statusMessage: string;
  progress: number | null;
  videoUrl: string | null;
  durationSeconds: number | null;
  error: string | null;
  publishState: AvatarPublishState;
  createdAt: string;
  updatedAt: string;
};

export function publicAvatarJob(row: AvatarJobRow): PublicAvatarJob {
  return {
    id: row.id,
    avatarId: row.avatar_id as AvatarId,
    voiceId: row.voice_id as TtsVoiceId,
    speed: Number(row.speed),
    text: row.text,
    status: row.status,
    statusMessage: row.status_message,
    progress: row.progress === null ? null : Number(row.progress),
    videoUrl: row.blob_url,
    durationSeconds:
      row.duration_seconds === null ? null : Number(row.duration_seconds),
    error: row.error,
    publishState: row.publish_state,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
