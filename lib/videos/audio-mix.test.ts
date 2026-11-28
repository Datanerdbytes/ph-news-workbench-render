import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudioMix, resumeAudioContext } from "./audio-mix";

function makeGain() {
  return {
    gain: {
      value: 0,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function makeContext(state = "running") {
  const gains: ReturnType<typeof makeGain>[] = [];
  const narrationSources: Array<{
    buffer: unknown;
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const resume = vi.fn(() => Promise.resolve());
  const decodeAudioData = vi.fn(() => Promise.resolve({ duration: 2 }));
  const context = {
    state,
    currentTime: 10,
    destination: {},
    createMediaStreamDestination: vi.fn(() => ({
      stream: { getAudioTracks: () => [] },
    })),
    createMediaElementSource: vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createGain: vi.fn(() => {
      const gain = makeGain();
      gains.push(gain);
      return gain;
    }),
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      };
      narrationSources.push(source);
      return source;
    }),
    decodeAudioData,
    resume,
  } as unknown as AudioContext;

  return { context, gains, narrationSources, resume, decodeAudioData };
}

function makeVideo(duration = 2) {
  return { duration } as HTMLVideoElement;
}

describe("resumeAudioContext", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not resume a context that is already running", async () => {
    const { context, resume } = makeContext();

    await resumeAudioContext(context);

    expect(resume).not.toHaveBeenCalled();
  });

  it("rejects when a suspended context does not resume in time", async () => {
    vi.useFakeTimers();
    const { context, resume } = makeContext("suspended");
    resume.mockReturnValue(new Promise<void>(() => {}));

    const result = expect(resumeAudioContext(context)).rejects.toThrow(
      "The browser blocked audio for the media bake.",
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await result;
  });
});

describe("createAudioMix", () => {
  it("rejects narration and avatar audio together", async () => {
    const { context, decodeAudioData } = makeContext();

    await expect(
      createAudioMix(context, {
        narration: new Blob(["speech"]),
        avatar: makeVideo(),
      }),
    ).rejects.toThrow("Choose either a voice-over or an avatar video for the bake.");
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it.each([
    [-1, 0],
    [2, 1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
  ])("normalizes original volume %s to %s", async (requested, expected) => {
    const { context, gains } = makeContext();

    const mix = await createAudioMix(context, {
      video: makeVideo(),
      originalVolume: requested,
    });

    expect(gains[0].gain.value).toBe(expected);
    mix.stop();
  });

  it("rejects narration that cannot be decoded", async () => {
    const { context, decodeAudioData } = makeContext();
    decodeAudioData.mockRejectedValueOnce(new Error("decode failed"));

    await expect(
      createAudioMix(context, { narration: new Blob(["speech"]) }),
    ).rejects.toThrow("The generated voice-over could not be decoded.");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects narration with invalid duration %s",
    async (duration) => {
      const { context, decodeAudioData } = makeContext();
      decodeAudioData.mockResolvedValueOnce({ duration } as AudioBuffer);

      await expect(
        createAudioMix(context, { narration: new Blob(["speech"]) }),
      ).rejects.toThrow("The generated voice-over has no playable audio.");
    },
  );

  it("uses the decoded narration duration", async () => {
    const { context, decodeAudioData } = makeContext();
    decodeAudioData.mockResolvedValueOnce({ duration: 12.5 } as AudioBuffer);

    const mix = await createAudioMix(context, {
      narration: new Blob(["speech"]),
    });

    expect(mix.duration).toBe(12.5);
    mix.stop();
  });

  it("exposes the decoded narration buffer for overlays", async () => {
    const { context, decodeAudioData } = makeContext();
    const buffer = { duration: 12.5 } as AudioBuffer;
    decodeAudioData.mockResolvedValueOnce(buffer);

    const withNarration = await createAudioMix(context, {
      narration: new Blob(["speech"]),
    });

    expect(withNarration.narrationBuffer).toBe(buffer);
    withNarration.stop();

    const withoutNarration = await createAudioMix(context, {
      avatar: makeVideo(8.5),
    });

    expect(withoutNarration.narrationBuffer).toBeNull();
    withoutNarration.stop();
  });

  it("uses a valid avatar duration", async () => {
    const { context } = makeContext();

    const mix = await createAudioMix(context, { avatar: makeVideo(8.5) });

    expect(mix.duration).toBe(8.5);
    mix.stop();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "reports no duration for an invalid avatar duration %s",
    async (duration) => {
      const { context } = makeContext();

      const mix = await createAudioMix(context, { avatar: makeVideo(duration) });

      expect(mix.duration).toBe(0);
      mix.stop();
    },
  );

  it("starts narration only once", async () => {
    const { context, narrationSources } = makeContext();
    const mix = await createAudioMix(context, {
      narration: new Blob(["speech"]),
    });

    mix.startNarration();
    mix.startNarration();

    expect(narrationSources[0].start).toHaveBeenCalledTimes(1);
    mix.stop();
  });

  it("ducks the footage only once when the avatar starts", async () => {
    const { context, gains } = makeContext();
    const mix = await createAudioMix(context, {
      video: makeVideo(),
      avatar: makeVideo(),
      originalVolume: 0.25,
    });

    mix.startAvatar();
    mix.startAvatar();

    expect(gains[0].gain.setValueAtTime).toHaveBeenCalledTimes(1);
    expect(gains[0].gain.setValueAtTime).toHaveBeenCalledWith(0.25, 10);
    mix.stop();
  });

  it("does not duck or restore footage before the avatar starts", async () => {
    const { context, gains } = makeContext();
    const mix = await createAudioMix(context, {
      video: makeVideo(),
      avatar: makeVideo(),
      originalVolume: 0.25,
    });

    mix.restoreOriginalAudio();

    expect(gains[0].gain.setValueAtTime).not.toHaveBeenCalled();
    expect(gains[0].gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    mix.stop();
  });

  it("restores the original footage volume after the avatar ends", async () => {
    const { context, gains } = makeContext();
    const mix = await createAudioMix(context, {
      video: makeVideo(),
      avatar: makeVideo(),
      originalVolume: 0.25,
    });

    mix.startAvatar();
    mix.restoreOriginalAudio();

    expect(gains[0].gain.cancelScheduledValues).toHaveBeenCalledTimes(2);
    expect(gains[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0.25, 10);
    expect(gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 10.2);
    mix.stop();
  });

  it("stops and disconnects narration when the mix stops", async () => {
    const { context, narrationSources } = makeContext();
    const mix = await createAudioMix(context, {
      narration: new Blob(["speech"]),
    });

    mix.startNarration();
    mix.stop();

    expect(narrationSources[0].stop).toHaveBeenCalledTimes(1);
    expect(narrationSources[0].disconnect).toHaveBeenCalledTimes(1);
  });
});
