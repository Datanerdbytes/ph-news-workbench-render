import {
  COMPOSITION_HEIGHT,
  COMPOSITION_WIDTH,
  avatarPlacementPixels,
  type AvatarPlacement,
} from "./composition";

const MAX_AVATAR_BYTES = 256 * 1024 * 1024;
const AVATAR_LOAD_TIMEOUT_MS = 60_000;
const MAX_AVATAR_REDIRECTS = 5;

export type LoadedAvatarVideo = {
  video: HTMLVideoElement;
  release: () => void;
};

function allowedAvatarUrl(url: URL): boolean {
  if (url.username || url.password) return false;
  if (url.protocol === "blob:") return Boolean(url.pathname);
  if (url.origin === window.location.origin) {
    return url.protocol === "https:" || url.protocol === "http:";
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "huggingface.co" ||
    host.endsWith(".public.blob.vercel-storage.com")
  );
}

async function readAvatarBlob(response: Response): Promise<Blob> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_AVATAR_BYTES) {
    throw new Error("The avatar video is too large to composite in this browser.");
  }
  const contentType = response.headers.get("content-type")?.split(";")[0].trim();
  if (
    contentType &&
    contentType !== "video/mp4" &&
    contentType !== "application/octet-stream" &&
    contentType !== "binary/octet-stream"
  ) {
    throw new Error("The avatar source is not an MP4 video.");
  }
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > MAX_AVATAR_BYTES) {
      throw new Error("The avatar video is too large to composite in this browser.");
    }
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_AVATAR_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("The avatar video is too large to composite in this browser.");
    }
    chunks.push(value);
  }
  return new Blob(chunks as BlobPart[], {
    type: contentType || "video/mp4",
  });
}

async function localAvatarSource(
  source: string,
  signal: AbortSignal,
): Promise<{ url: string; owned: boolean }> {
  let current = new URL(source, window.location.href);
  if (!allowedAvatarUrl(current)) {
    throw new Error("The avatar video source is not supported.");
  }
  if (current.protocol === "blob:") return { url: current.href, owned: false };

  let response!: Response;
  for (let redirects = 0; redirects <= MAX_AVATAR_REDIRECTS; redirects += 1) {
    response = await fetch(current, {
      credentials: "omit",
      redirect: "manual",
      signal,
    });
    if (response.type === "opaqueredirect") {
      throw new Error("The avatar video redirect could not be verified.");
    }
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("The avatar video redirect is invalid.");
    }
    current = new URL(location, current);
    if (!allowedAvatarUrl(current)) {
      throw new Error("The avatar video redirect is not allowed.");
    }
    if (redirects === MAX_AVATAR_REDIRECTS) {
      throw new Error("The avatar video redirected too many times.");
    }
  }
  if (!response.ok) {
    throw new Error("The avatar video could not be loaded for compositing.");
  }
  const finalUrl = new URL(response.url || current.href);
  if (!allowedAvatarUrl(finalUrl)) {
    throw new Error("The avatar video response came from an unapproved source.");
  }

  const blob = await readAvatarBlob(response);
  if (!blob.size) {
    throw new Error("The avatar video is empty.");
  }
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (
    header.length < 8 ||
    String.fromCharCode(...header.subarray(4, 8)) !== "ftyp"
  ) {
    throw new Error("The avatar source is not a valid MP4 video.");
  }
  return { url: URL.createObjectURL(blob), owned: true };
}

export async function loadAvatarVideo(source: string): Promise<LoadedAvatarVideo> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    AVATAR_LOAD_TIMEOUT_MS,
  );
  let local: { url: string; owned: boolean } | undefined;
  const video = document.createElement("video");
  video.playsInline = true;
  video.preload = "auto";

  try {
    local = await localAvatarSource(source, controller.signal);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        video.onloadeddata = null;
        video.onerror = null;
        reject(new Error("The avatar video took too long to load."));
      }, AVATAR_LOAD_TIMEOUT_MS);
      video.onloadeddata = () => {
        clearTimeout(timer);
        video.onloadeddata = null;
        video.onerror = null;
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        video.onloadeddata = null;
        video.onerror = null;
        reject(new Error("The avatar video could not be decoded."));
      };
      video.src = local!.url;
      video.load();
    });
    if (
      !Number.isFinite(video.duration) ||
      video.duration <= 0 ||
      !video.videoWidth ||
      !video.videoHeight
    ) {
      throw new Error("The avatar video has no playable media.");
    }
    video.currentTime = 0;
    return {
      video,
      release: () => {
        video.onloadeddata = null;
        video.onerror = null;
        video.pause();
        video.removeAttribute("src");
        video.load();
        if (local?.owned) URL.revokeObjectURL(local.url);
      },
    };
  } catch (error) {
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (local?.owned) URL.revokeObjectURL(local.url);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The avatar video took too long to load.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function drawAvatarVideo(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  placement: AvatarPlacement,
  width = COMPOSITION_WIDTH,
  height = COMPOSITION_HEIGHT,
): void {
  if (video.readyState < 2) return;
  const sourceWidth = video.videoWidth || 16;
  const sourceHeight = video.videoHeight || 9;
  const pixels = avatarPlacementPixels(
    placement,
    sourceWidth / sourceHeight,
    width,
    height,
  );
  context.drawImage(
    video,
    pixels.x,
    pixels.y,
    pixels.width,
    pixels.height,
  );
}
