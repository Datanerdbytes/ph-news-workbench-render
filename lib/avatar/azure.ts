import { createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { buildTtsSsml } from "@/lib/tts/azure";
import type { TtsVoiceId } from "@/lib/tts/voices";
import { getAvatar, type AvatarId } from "./avatars";
import {
  deferAvatarRequests,
  waitForAvatarRequest,
} from "./provider-rate-limit";

const API_VERSION = "2024-08-01";
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export class AvatarError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable = true,
  ) {
    super(message);
    this.name = "AvatarError";
  }
}

export type AvatarSynthesis = {
  id: string;
  status: "NotStarted" | "Running" | "Succeeded" | "Failed";
  resultUrl?: string;
  durationSeconds?: number;
  billedAvatarSeconds?: number;
  errorCode?: string;
};

function avatarSpeechKey(): string {
  return (
    process.env.AZURE_AVATAR_SPEECH_KEY?.trim() ||
    process.env.AZURE_SPEECH_KEY?.trim() ||
    ""
  );
}

export function avatarEndpoint(): string {
  const key = avatarSpeechKey();
  const region = (
    process.env.AZURE_AVATAR_SPEECH_REGION?.trim() ||
    process.env.AZURE_SPEECH_REGION?.trim() ||
    ""
  );
  if (!key || !region) {
    throw new AvatarError(
      503,
      "not_configured",
      "Talking avatars are not configured. Add AZURE_AVATAR_SPEECH_KEY and AZURE_AVATAR_SPEECH_REGION, or use an S0 AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.",
      false,
    );
  }
  if (!/^[a-z0-9-]+$/i.test(region)) {
    throw new AvatarError(
      503,
      "not_configured",
      "AZURE_AVATAR_SPEECH_REGION is invalid.",
      false,
    );
  }

  const configured = process.env.AZURE_AVATAR_SPEECH_ENDPOINT?.trim();
  const base = configured || `https://${region}.api.cognitive.microsoft.com`;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new AvatarError(
      503,
      "not_configured",
      "AZURE_AVATAR_SPEECH_ENDPOINT is invalid.",
      false,
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new AvatarError(
      503,
      "not_configured",
      "AZURE_AVATAR_SPEECH_ENDPOINT must be an HTTPS origin.",
      false,
    );
  }
  return parsed.origin;
}

function requestHeaders(key: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Ocp-Apim-Subscription-Key": key,
    "User-Agent": "PH-News-Workbench/1.0",
  };
}

function synthesisUrl(endpoint: string, id: string): string {
  return `${endpoint}/avatar/batchsyntheses/${encodeURIComponent(id)}?api-version=${API_VERSION}`;
}

function providerError(status: number): AvatarError {
  if (status === 429) {
    return new AvatarError(
      429,
      "rate_limited",
      "The avatar service is busy. Please try again shortly.",
    );
  }
  if (status === 401 || status === 403) {
    return new AvatarError(
      503,
      "not_configured",
      "Avatar credentials were rejected. Check the S0 Speech resource configuration.",
      false,
    );
  }
  if (status === 400) {
    return new AvatarError(
      502,
      "avatar_rejected",
      "The avatar service could not process this draft. Edit it and try again.",
      false,
    );
  }
  return new AvatarError(
    502,
    "provider_error",
    "The avatar service is unavailable. Please try again shortly.",
  );
}

async function responseError(response: Response): Promise<AvatarError> {
  if (response.status === 429) deferAvatarRequests(response);
  return providerError(response.status);
}

function parseSynthesis(value: unknown): AvatarSynthesis {
  if (!value || typeof value !== "object") {
    throw new AvatarError(502, "invalid_response", "The avatar service returned an invalid response.");
  }
  const body = value as {
    id?: unknown;
    status?: unknown;
    outputs?: { result?: unknown };
    properties?: {
      durationInMilliseconds?: unknown;
      billingDetails?: { talkingAvatarDurationSeconds?: unknown };
      error?: { code?: unknown };
    };
  };
  if (
    typeof body.id !== "string" ||
    !["NotStarted", "Running", "Succeeded", "Failed"].includes(String(body.status))
  ) {
    throw new AvatarError(502, "invalid_response", "The avatar service returned an invalid response.");
  }
  const duration = Number(body.properties?.durationInMilliseconds);
  const billed = Number(body.properties?.billingDetails?.talkingAvatarDurationSeconds);
  return {
    id: body.id,
    status: body.status as AvatarSynthesis["status"],
    resultUrl:
      typeof body.outputs?.result === "string" ? body.outputs.result : undefined,
    durationSeconds: Number.isFinite(duration) && duration >= 0 ? duration / 1000 : undefined,
    billedAvatarSeconds: Number.isFinite(billed) && billed >= 0 ? billed : undefined,
    errorCode:
      typeof body.properties?.error?.code === "string"
        ? body.properties.error.code
        : undefined,
  };
}

export async function submitAvatarSynthesis(input: {
  synthesisId: string;
  text: string;
  avatarId: AvatarId;
  voiceId: TtsVoiceId;
  speed: number;
}): Promise<AvatarSynthesis> {
  const endpoint = avatarEndpoint();
  const key = avatarSpeechKey();
  const avatar = getAvatar(input.avatarId);
  const avatarConfig = {
    talkingAvatarCharacter: avatar.character,
    ...(avatar.kind === "video"
      ? { talkingAvatarStyle: avatar.style, customized: false }
      : { photoAvatarBaseModel: "vasa-1" }),
    videoFormat: "mp4",
    videoCodec: "h264",
    subtitleType: "none",
    bitrateKbps: 2000,
  };

  let response: Response;
  await waitForAvatarRequest();
  try {
    response = await fetch(synthesisUrl(endpoint, input.synthesisId), {
      method: "PUT",
      headers: { ...requestHeaders(key), "Operation-Id": input.synthesisId },
      body: JSON.stringify({
        inputKind: "SSML",
        inputs: [
          { content: buildTtsSsml(input.text, input.voiceId, input.speed) },
        ],
        avatarConfig,
        properties: { timeToLiveInHours: 24 },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AvatarError(
      502,
      "provider_error",
      "The avatar service could not be reached. Please try again shortly.",
    );
  }
  if (!response.ok) throw await responseError(response);
  return parseSynthesis(await response.json().catch(() => null));
}

export async function getAvatarSynthesis(
  synthesisId: string,
): Promise<AvatarSynthesis | null> {
  const endpoint = avatarEndpoint();
  const key = avatarSpeechKey();
  let response: Response;
  await waitForAvatarRequest();
  try {
    response = await fetch(synthesisUrl(endpoint, synthesisId), {
      headers: requestHeaders(key),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AvatarError(
      502,
      "provider_error",
      "The avatar service could not be reached. Please try again shortly.",
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) throw await responseError(response);
  return parseSynthesis(await response.json().catch(() => null));
}

export async function deleteAvatarSynthesis(synthesisId: string): Promise<void> {
  const endpoint = avatarEndpoint();
  const key = avatarSpeechKey();
  await waitForAvatarRequest();
  try {
    const response = await fetch(synthesisUrl(endpoint, synthesisId), {
      method: "DELETE",
      headers: requestHeaders(key),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) {
      throw await responseError(response);
    }
  } catch (error) {
    if (error instanceof AvatarError) throw error;
    throw new AvatarError(
      502,
      "provider_error",
      "The avatar service could not be reached.",
    );
  }
}

function resultUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AvatarError(502, "invalid_result", "The avatar service returned an invalid video URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !(parsed.hostname === "blob.core.windows.net" || parsed.hostname.endsWith(".blob.core.windows.net"))
  ) {
    throw new AvatarError(502, "invalid_result", "The avatar service returned an invalid video URL.");
  }
  return parsed;
}

export async function downloadAvatarResult(input: {
  url: string;
  destination: string;
  maxBytes: number;
}): Promise<number> {
  let current = resultUrl(input.url);
  let response: Response | undefined;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    try {
      response = await fetch(current, {
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch {
      throw new AvatarError(502, "download_failed", "The generated avatar video could not be downloaded.");
    }
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) break;
    current = resultUrl(new URL(location, current).href);
    response = undefined;
  }
  if (!response || !response.ok || !response.body) {
    throw new AvatarError(502, "download_failed", "The generated avatar video could not be downloaded.");
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > input.maxBytes) {
    throw new AvatarError(502, "video_too_large", "The generated avatar video is too large.");
  }

  let downloaded = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloaded += chunk.length;
      if (downloaded > input.maxBytes) {
        callback(new AvatarError(502, "video_too_large", "The generated avatar video is too large."));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
      limiter,
      createWriteStream(input.destination),
    );
  } catch (error) {
    if (error instanceof AvatarError) throw error;
    throw new AvatarError(502, "download_failed", "The generated avatar video could not be downloaded.");
  }

  const info = await stat(input.destination);
  const header = Buffer.alloc(12);
  const file = await open(input.destination, "r");
  try {
    await file.read(header, 0, header.length, 0);
  } finally {
    await file.close();
  }
  if (info.size === 0 || header.toString("ascii", 4, 8) !== "ftyp") {
    throw new AvatarError(502, "invalid_video", "The avatar service did not return a valid MP4.");
  }
  return info.size;
}
