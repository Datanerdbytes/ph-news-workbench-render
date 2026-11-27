import type { AvatarOutputFormat } from "./jobs";

const EBML_HEADER = [0x1a, 0x45, 0xdf, 0xa3];

export function avatarMediaType(format: AvatarOutputFormat): string {
  return format === "webm" ? "video/webm" : "video/mp4";
}

export function avatarMediaExtension(format: AvatarOutputFormat): string {
  return format === "webm" ? "webm" : "mp4";
}

export function hasAvatarHeader(
  bytes: Uint8Array,
  format: AvatarOutputFormat,
): boolean {
  if (format === "mp4") {
    return (
      bytes.length >= 8 &&
      String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp"
    );
  }
  return EBML_HEADER.every((byte, index) => bytes[index] === byte);
}

export function supportsTransparentAvatarPreview(): boolean {
  if (typeof document === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const support = document
    .createElement("video")
    .canPlayType('video/webm; codecs="vp9"');
  if (support !== "probably" && support !== "maybe") return false;
  const userAgent = navigator.userAgent;
  // iOS browsers with these tokens use WebKit, which does not preserve VP9 alpha.
  if (/crios|fxios|edgios/i.test(userAgent)) return false;
  const chromium = /chrome|crios|edg|opr|android/i.test(userAgent);
  const firefox = /firefox|fxios/i.test(userAgent);
  // Safari can decode VP9 but doesn't preserve its alpha channel on canvas.
  return chromium || firefox || !/safari/i.test(userAgent);
}
