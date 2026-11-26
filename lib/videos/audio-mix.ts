export const MAX_NARRATED_SECONDS = 600;
const AUDIO_START_TIMEOUT_MS = 3000;

export type AudioMix = {
  destination: MediaStreamAudioDestinationNode;
  duration: number;
  startNarration: () => void;
  stop: () => void;
};

export async function resumeAudioContext(context: AudioContext): Promise<void> {
  if (context.state !== "suspended") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      context.resume(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("The browser blocked audio for the media bake.")),
          AUDIO_START_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createAudioMix(
  context: AudioContext,
  options: {
    video?: HTMLVideoElement;
    narration?: Blob;
    originalVolume?: number;
  },
): Promise<AudioMix> {
  const destination = context.createMediaStreamDestination();
  const originalVolume = Math.max(
    0,
    Math.min(1, options.originalVolume ?? 1),
  );
  let videoSource: MediaElementAudioSourceNode | undefined;
  let originalGain: GainNode | undefined;
  let monitor: GainNode | undefined;
  let narrationSource: AudioBufferSourceNode | undefined;
  let narrationBuffer: AudioBuffer | undefined;
  let narrationStarted = false;

  if (options.video) {
    videoSource = context.createMediaElementSource(options.video);
    originalGain = context.createGain();
    originalGain.gain.value = originalVolume;
    videoSource.connect(originalGain);
    originalGain.connect(destination);
    monitor = context.createGain();
    monitor.gain.value = 0;
    videoSource.connect(monitor);
    monitor.connect(context.destination);
  }

  await resumeAudioContext(context);

  if (options.narration) {
    try {
      narrationBuffer = await context.decodeAudioData(
        await options.narration.arrayBuffer(),
      );
    } catch {
      throw new Error("The generated voice-over could not be decoded.");
    }
    if (!Number.isFinite(narrationBuffer.duration) || narrationBuffer.duration <= 0) {
      throw new Error("The generated voice-over has no playable audio.");
    }
    narrationSource = context.createBufferSource();
    narrationSource.buffer = narrationBuffer;
    narrationSource.connect(destination);
  }

  return {
    destination,
    duration: narrationBuffer?.duration ?? 0,
    startNarration: () => {
      if (narrationStarted) return;
      narrationSource?.start();
      narrationStarted = true;
    },
    stop: () => {
      if (narrationStarted) narrationSource?.stop();
      narrationSource?.disconnect();
      videoSource?.disconnect();
      originalGain?.disconnect();
      monitor?.disconnect();
    },
  };
}
