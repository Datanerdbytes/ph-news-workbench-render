import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReelTranscodeArgs, localRuntimeEnabled } from "./media";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildReelTranscodeArgs", () => {
  it("encodes H.264/AAC 1080x1920 faststart", () => {
    const args = buildReelTranscodeArgs("/tmp/in.mov", "/tmp/out.mp4");
    expect(args[args.indexOf("-i") + 1]).toBe("/tmp/in.mov");
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
    expect(args).toContain("+faststart");
    expect(args).toContain(
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
    );
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
  });

  it("writes the Facebook-safe audio/video spec", () => {
    const args = buildReelTranscodeArgs("/tmp/in.mov", "/tmp/out.mp4");
    expect(args[args.indexOf("-fps_mode") + 1]).toBe("cfr");
    expect(args[args.indexOf("-ar") + 1]).toBe("48000");
    expect(args[args.indexOf("-ac") + 1]).toBe("2");
    expect(args[args.indexOf("-af") + 1]).toBe(
      "aresample=async=1:first_pts=0"
    );
    expect(args[args.indexOf("-preset") + 1]).toBe("veryfast");
  });
});

describe("localRuntimeEnabled", () => {
  it("allows local processing in dev runs", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(localRuntimeEnabled()).toBe(true);
  });

  it("requires an explicit opt-in outside development", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(localRuntimeEnabled()).toBe(false);

    vi.stubEnv("ENABLE_LOCAL_VIDEO_PROCESSING", "1");
    expect(localRuntimeEnabled()).toBe(true);
  });

  it("also honors the legacy HyperFrames opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HYPERFRAMES_ENABLE_RENDER", "1");
    expect(localRuntimeEnabled()).toBe(true);
  });
});
