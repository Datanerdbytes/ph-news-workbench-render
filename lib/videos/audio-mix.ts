export const MAX_NARRATED_SECONDS = 600;
const AUDIO_START_TIMEOUT_MS = 3000;

export type AudioMix = {
  destination: MediaStreamAudioDestinationNode;
  duration: number;
  startNarration: () => void;
  startAvatar: () => void;
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
    avatar?: HTMLVideoElement;
    narration?: Blob;
    originalVolume?: number;
  },
): Promise<AudioMix> {
  if (options.narration && options.avatar) {
    throw new Error("Choose either a voice-over or an avatar video for the bake.");
  }
  const destination = context.createMediaStreamDestination();
  const requestedVolume = options.originalVolume ?? 1;
  const originalVolume = Number.isFinite(requestedVolume)
    ? Math.max(0, Math.min(1, requestedVolume))
    : 1;
  const monitors: GainNode[] = [];
  let videoSource: MediaElementAudioSourceNode | undefined;
  let originalGain: GainNode | undefined;
  let avatarSource: MediaElementAudioSourceNode | undefined;
  let avatarGain: GainNode | undefined;
  let narrationSource: AudioBufferSourceNode | undefined;
  let narrationBuffer: AudioBuffer | undefined;
  let narrationStarted = false;
  let avatarStarted = false;

  function connectMedia(element: HTMLVideoElement, volume: number) {
    const source = context.createMediaElementSource(element);
    const gain = context.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(destination);
    const monitor = context.createGain();
    monitor.gain.value = 0;
    source.connect(monitor);
    monitor.connect(context.destination);
    monitors.push(monitor);
    return { source, gain };
  }

  if (options.video) {
    const connected = connectMedia(options.video, originalVolume);
    videoSource = connected.source;
    originalGain = connected.gain;
  }
  if (options.avatar) {
    const connected = connectMedia(options.avatar, 1);
    avatarSource = connected.source;
    avatarGain = connected.gain;
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

  const avatarDuration =
    options.avatar &&
    Number.isFinite(options.avatar.duration) &&
    options.avatar.duration > 0
      ? options.avatar.duration
      : 0;

  return {
    destination,
    duration: narrationBuffer?.duration ?? avatarDuration,
    startNarration: () => {
      if (narrationStarted) return;
      narrationSource?.start();
      narrationStarted = true;
    },
    startAvatar: () => {
      if (avatarStarted) return;
      avatarStarted = true;
      if (!originalGain || !avatarDuration) return;
      const now = context.currentTime;
      originalGain.gain.cancelScheduledValues(now);
      originalGain.gain.setValueAtTime(originalVolume, now);
      originalGain.gain.setValueAtTime(originalVolume, now + avatarDuration);
      originalGain.gain.linearRampToValueAtTime(1, now + avatarDuration + 0.2);
    },
    stop: () => {
      if (narrationStarted) narrationSource?.stop();
      narrationSource?.disconnect();
      videoSource?.disconnect();
      originalGain?.disconnect();
      avatarSource?.disconnect();
      avatarGain?.disconnect();
      for (const monitor of monitors) monitor.disconnect();
    },
  };
}
