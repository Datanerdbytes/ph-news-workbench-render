import { EventEmitter } from 'node:events';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import {
  assembleRtmpsUrl,
  buildPumpArgs,
  decideTranscode,
  getPumpManager,
  REDACTED_KEY,
  redactStreamKey,
  RETRY_BACKOFF_MS,
  STOP_GRACE_MS,
  type VideoStreams,
} from './pump';

const spawnMock = spawn as unknown as Mock;

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: Mock;
  pid: number;
};

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  child.pid = 4242;
  return child;
}

function closeChild(child: FakeChild, code: number | null): void {
  child.emit('close', code, null);
}

function stderrLine(child: FakeChild, text: string): void {
  child.stderr.emit('data', Buffer.from(text));
}

const LIVE_HLS = 'https://manifest.example/live/playlist.m3u8';
const VOD_MP4 = 'https://cdn.example/vod.mp4';
const STREAM_KEY = '1_secret-key-do-not-leak';
const RTMPS_BASE = 'rtmps://live-api-s.facebook.com:443/rtmp/1234567890/';
const DEST = `${RTMPS_BASE}${STREAM_KEY}`;

const PROBE_COPY: VideoStreams = {
  videoCodec: 'h264',
  pixelFormat: 'yuv420p',
  audioCodec: 'aac',
};
const PROBE_AV1: VideoStreams = {
  videoCodec: 'av1',
  pixelFormat: 'yuv420p10le',
  audioCodec: 'opus',
};

/** Builds an ffprobe `-show_streams -of json` body from a probe fixture. */
function buildProbeJson(probe: VideoStreams): string {
  const streams: Record<string, string>[] = [];
  if (probe.videoCodec !== null) {
    streams.push({
      codec_type: 'video',
      codec_name: probe.videoCodec,
      pix_fmt: probe.pixelFormat ?? '',
    });
  }
  if (probe.audioCodec !== null) {
    streams.push({ codec_type: 'audio', codec_name: probe.audioCodec });
  }
  return JSON.stringify({ streams });
}

/**
 * Wires the mocked spawn: ffprobe children answer immediately with the given
 * probe JSON, ffmpeg children stay silent until the test drives them.
 */
function useSpawns(
  options: { probe?: VideoStreams; probeFails?: boolean } = {}
): { ffmpegKids: FakeChild[]; ffprobeKids: FakeChild[] } {
  const ffmpegKids: FakeChild[] = [];
  const ffprobeKids: FakeChild[] = [];
  spawnMock.mockImplementation((command: string) => {
    const kid = makeFakeChild();
    if (command === 'ffprobe') {
      ffprobeKids.push(kid);
      queueMicrotask(() => {
        if (options.probeFails) {
          closeChild(kid, 1);
        } else {
          kid.stdout.emit('data', Buffer.from(buildProbeJson(options.probe ?? PROBE_COPY)));
          closeChild(kid, 0);
        }
      });
    } else {
      ffmpegKids.push(kid);
    }
    return kid;
  });
  return { ffmpegKids, ffprobeKids };
}

function ffmpegArgsList(): string[][] {
  return spawnMock.mock.calls
    .filter(([command]) => command === 'ffmpeg')
    .map((call) => call[1] as string[]);
}

function firstFfmpegArgs(): string[] {
  const args = ffmpegArgsList()[0];
  expect(args, 'expected ffmpeg to have been spawned').toBeDefined();
  return args;
}

function stubGateOn(): void {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('ENABLE_LOCAL_VIDEO_PROCESSING', '');
  vi.stubEnv('HYPERFRAMES_ENABLE_RENDER', '');
}

const manager = getPumpManager();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

beforeEach(() => {
  manager.resetForTests();
  spawnMock.mockReset();
});

describe('decideTranscode', () => {
  it('h264 + yuv420p + aac copies (returns false)', () => {
    expect(decideTranscode(PROBE_COPY)).toBe(false);
  });

  it('av1 video needs transcoding (returns true)', () => {
    expect(decideTranscode(PROBE_AV1)).toBe(true);
  });

  it('hevc video needs transcoding (returns true)', () => {
    expect(
      decideTranscode({ videoCodec: 'hevc', pixelFormat: 'yuv420p', audioCodec: 'aac' })
    ).toBe(true);
  });

  it('h264 with mp3 audio copies (returns false)', () => {
    expect(
      decideTranscode({ videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodec: 'mp3' })
    ).toBe(false);
  });

  it('h264 with no audio track copies (returns false)', () => {
    expect(
      decideTranscode({ videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodec: null })
    ).toBe(false);
  });

  it('h264 with an exotic audio codec needs transcoding (returns true)', () => {
    expect(
      decideTranscode({ videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodec: 'opus' })
    ).toBe(true);
  });

  it('null video codec needs transcoding (returns true)', () => {
    expect(
      decideTranscode({ videoCodec: null, pixelFormat: null, audioCodec: 'aac' })
    ).toBe(true);
  });
});

describe('buildPumpArgs', () => {
  it('copy path over live HLS adds reconnect flags, -re, -c copy, -f flv and puts dest last', () => {
    const args = buildPumpArgs({ source: LIVE_HLS, dest: DEST, needsTranscode: false });
    expect(args.slice(0, 6)).toEqual([
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_on_network_error',
      '1',
    ]);
    expect(args).toContain('-re');
    expect(args).toContain('-c');
    expect(args).toContain('copy');
    expect(args).toContain('-f');
    expect(args).toContain('flv');
    expect(args[args.length - 1]).toBe(DEST);
    expect(args).not.toContain('libx264');
  });

  it('copy path over a plain file source omits the reconnect flags', () => {
    const args = buildPumpArgs({ source: VOD_MP4, dest: DEST, needsTranscode: false });
    expect(args).not.toContain('-reconnect');
    expect(args).toContain('-re');
    expect(args[args.length - 1]).toBe(DEST);
  });

  it('transcode path swaps -c copy for libx264 + aac + yuv420p and puts dest last', () => {
    const args = buildPumpArgs({ source: LIVE_HLS, dest: DEST, needsTranscode: true });
    expect(args).toContain('libx264');
    expect(args).toContain('veryfast');
    expect(args).toContain('23');
    expect(args).toContain('yuv420p');
    expect(args).toContain('aac');
    expect(args).toContain('128k');
    expect(args).not.toContain('copy');
    expect(args[args.length - 1]).toBe(DEST);
  });
});

describe('assembleRtmpsUrl', () => {
  it('joins a base with trailing slash and the key', () => {
    expect(assembleRtmpsUrl(RTMPS_BASE, STREAM_KEY)).toBe(DEST);
  });

  it('inserts the trailing slash when the base lacks one', () => {
    expect(assembleRtmpsUrl(RTMPS_BASE.replace(/\/$/, ''), STREAM_KEY)).toBe(DEST);
  });

  it('returns null when the key is missing', () => {
    expect(assembleRtmpsUrl(RTMPS_BASE, null)).toBeNull();
  });

  it('returns null when the base is missing', () => {
    expect(assembleRtmpsUrl(null, STREAM_KEY)).toBeNull();
  });
});

describe('redactStreamKey', () => {
  it('replaces every occurrence of the key with ***', () => {
    const line = `handshake with ${DEST} failed; auth for ${STREAM_KEY} rejected\nretrying ${STREAM_KEY}`;
    const redacted = redactStreamKey(line, DEST);
    expect(redacted).not.toContain(STREAM_KEY);
    expect(redacted).not.toContain(DEST);
    expect(redacted).toContain(`${RTMPS_BASE}${REDACTED_KEY}`);
    expect(redacted.split(REDACTED_KEY).length - 1).toBe(3);
  });

  it('leaves text without the key untouched', () => {
    expect(redactStreamKey('plain ffmpeg failure', DEST)).toBe('plain ffmpeg failure');
  });

  it('passes text through when there is no dest to redact against', () => {
    expect(redactStreamKey('anything', null)).toBe('anything');
    expect(redactStreamKey('', DEST)).toBe('');
  });
});

describe('PumpManager gate', () => {
  it('production mode with the gate env unset refuses start() and never spawns', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_LOCAL_VIDEO_PROCESSING', '');
    vi.stubEnv('HYPERFRAMES_ENABLE_RENDER', '');
    spawnMock.mockImplementation(() => makeFakeChild());

    const result = await manager.start({ id: 9, source: LIVE_HLS, dest: DEST });

    expect(result).toEqual({
      ok: false,
      reason: 'gate_disabled',
      error: expect.any(String),
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(manager.status(9).running).toBe(false);
  });
});

describe('PumpManager state machine', () => {
  it('a started pump reports running with startedAt and no error', async () => {
    stubGateOn();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });

    const result = await manager.start({ id: 7, source: LIVE_HLS, dest: DEST });

    expect(result).toEqual({ ok: true });
    expect(ffmpegKids).toHaveLength(1);
    const status = manager.status(7);
    expect(status.running).toBe(true);
    expect(status.startedAt).toBeInstanceOf(Date);
    expect(status.error).toBeNull();
  });

  it('a second start for a live pump is rejected without spawning again', async () => {
    stubGateOn();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await manager.start({ id: 7, source: LIVE_HLS, dest: DEST });

    const second = await manager.start({ id: 7, source: LIVE_HLS, dest: DEST });

    expect(second).toEqual({
      ok: false,
      reason: 'already_running',
      error: expect.any(String),
    });
    expect(ffmpegKids).toHaveLength(1);
  });

  it('an unknown id reports not running with no startedAt and no error', () => {
    expect(manager.status('nope')).toEqual({
      running: false,
      startedAt: null,
      error: null,
    });
  });

  it('stop sends SIGINT first and SIGKILL only after the 5s grace period', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await manager.start({ id: 7, source: LIVE_HLS, dest: DEST });

    expect(manager.stop(7)).toEqual({ ok: true, wasRunning: true });
    expect(ffmpegKids[0].kill).toHaveBeenCalledWith('SIGINT');
    expect(ffmpegKids[0].kill).not.toHaveBeenCalledWith('SIGKILL');

    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(ffmpegKids[0].kill).not.toHaveBeenCalledWith('SIGKILL');

    await vi.advanceTimersByTimeAsync(1);
    expect(ffmpegKids[0].kill).toHaveBeenCalledWith('SIGKILL');

    closeChild(ffmpegKids[0], null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ffmpegKids).toHaveLength(1);
    const status = manager.status(7);
    expect(status.running).toBe(false);
    expect(status.error).toBeNull();
  });

  it('a pump that closes cleanly before the grace period is never SIGKILLed', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await manager.start({ id: 7, source: LIVE_HLS, dest: DEST });

    manager.stop(7);
    closeChild(ffmpegKids[0], 0);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + 60_000);

    expect(ffmpegKids[0].kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(manager.status(7).running).toBe(false);
  });

  it('stopping an unknown id is an idempotent no-op', () => {
    expect(manager.stop(1234)).toEqual({ ok: true, wasRunning: false });
  });
});

describe('PumpManager retry policy', () => {
  it('exit 1 mid-stream retries up to 3 times with 2s/4s/8s backoff, then records the last error', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await manager.start({ id: 7, source: LIVE_HLS, dest: DEST });
    expect(ffmpegKids).toHaveLength(1);

    // Attempt 1 fails → 2s backoff.
    closeChild(ffmpegKids[0], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[0] - 1);
    expect(ffmpegKids).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ffmpegKids).toHaveLength(2);

    // Attempt 2 fails → 4s backoff.
    closeChild(ffmpegKids[1], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[1] - 1);
    expect(ffmpegKids).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(ffmpegKids).toHaveLength(3);

    // Attempt 3 fails → 8s backoff.
    closeChild(ffmpegKids[2], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[2] - 1);
    expect(ffmpegKids).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(ffmpegKids).toHaveLength(4);

    // Attempt 4 (the third retry) fails → give up.
    closeChild(ffmpegKids[3], 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ffmpegKids).toHaveLength(4);

    const status = manager.status(7);
    expect(status.running).toBe(false);
    expect(status.error).toContain('code 1');
    expect(status.error).toContain('retries');
  });

  it('a pump that recovered on a retry ends cleanly with no recorded error', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await manager.start({ id: 7, source: LIVE_HLS, dest: DEST });

    closeChild(ffmpegKids[0], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[0]);
    expect(ffmpegKids).toHaveLength(2);
    closeChild(ffmpegKids[1], 0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ffmpegKids).toHaveLength(2);
    const status = manager.status(7);
    expect(status.running).toBe(false);
    expect(status.error).toBeNull();
  });

  it('exit 0 (input ended cleanly) never schedules a retry', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await manager.start({ id: 7, source: LIVE_HLS, dest: DEST });

    closeChild(ffmpegKids[0], 0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ffmpegKids).toHaveLength(1);
    const status = manager.status(7);
    expect(status.running).toBe(false);
    expect(status.error).toBeNull();
  });

  it('a retry-waiting pump still refuses a second start', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await manager.start({ id: 7, source: LIVE_HLS, dest: DEST });

    closeChild(ffmpegKids[0], 1);
    const second = await manager.start({ id: 7, source: LIVE_HLS, dest: DEST });

    expect(second).toEqual({
      ok: false,
      reason: 'already_running',
      error: expect.any(String),
    });
  });
});

describe('PumpManager stderr watchdog', () => {
  it('"Already publishing" fails the pump fast: SIGKILL, no retries, error recorded', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await manager.start({ id: 7, source: LIVE_HLS, dest: DEST });

    stderrLine(ffmpegKids[0], 'rtmp://ingest: command "publish" failed: Already publishing');
    expect(ffmpegKids[0].kill).toHaveBeenCalledWith('SIGKILL');
    closeChild(ffmpegKids[0], 1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ffmpegKids).toHaveLength(1);
    const status = manager.status(7);
    expect(status.running).toBe(false);
    expect(status.error).toContain('Already publishing');
  });

  it('"Connection refused" from the ingest endpoint is also treated as fatal', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await manager.start({ id: 7, source: LIVE_HLS, dest: DEST });

    stderrLine(ffmpegKids[0], 'tcp://live-api-s.facebook.com:443: Connection refused');
    closeChild(ffmpegKids[0], 1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ffmpegKids).toHaveLength(1);
    expect(manager.status(7).error).toContain('Connection refused');
  });
});

describe('PumpManager key secrecy', () => {
  it('stderr tails and recorded errors contain *** instead of the stream key', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await manager.start({ id: 11, source: LIVE_HLS, dest: DEST });

    stderrLine(
      ffmpegKids[0],
      `handshake with ${DEST} failed\nbad auth for ${STREAM_KEY}\navc: connection lost`
    );
    closeChild(ffmpegKids[0], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[0]);
    stderrLine(ffmpegKids[1], `retry also failed for ${STREAM_KEY}`);
    closeChild(ffmpegKids[1], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[1]);
    stderrLine(ffmpegKids[2], `third failure on ${STREAM_KEY}`);
    closeChild(ffmpegKids[2], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[2]);
    closeChild(ffmpegKids[3], 1);
    await vi.advanceTimersByTimeAsync(60_000);

    const status = manager.status(11);
    expect(status.error).not.toBeNull();
    expect(status.error).not.toContain(STREAM_KEY);
    expect(status.error).not.toContain(DEST);
    expect(status.error).toContain(REDACTED_KEY);
  });

  it('fatal stderr lines containing the key are redacted before recording', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await manager.start({ id: 11, source: LIVE_HLS, dest: DEST });

    stderrLine(ffmpegKids[0], `publish rejected for ${STREAM_KEY}: Already publishing`);
    closeChild(ffmpegKids[0], 1);
    await vi.advanceTimersByTimeAsync(60_000);

    const status = manager.status(11);
    expect(status.error).toContain('Already publishing');
    expect(status.error).not.toContain(STREAM_KEY);
  });
});

describe('PumpManager ffprobe path', () => {
  it('probes the source with ffprobe and copies when the probe reports h264/aac', async () => {
    stubGateOn();
    const { ffprobeKids } = useSpawns({ probe: PROBE_COPY });

    await manager.start({ id: 3, source: LIVE_HLS, dest: DEST });

    expect(ffprobeKids).toHaveLength(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-of', 'json', LIVE_HLS],
      expect.anything()
    );
    const args = firstFfmpegArgs();
    expect(args).toContain('-reconnect');
    const cIndex = args.indexOf('-c');
    expect(args[cIndex + 1]).toBe('copy');
    expect(args).not.toContain('libx264');
    expect(args[args.length - 1]).toBe(DEST);
  });

  it('switches to transcoding when the probe reports av1', async () => {
    stubGateOn();
    const { ffmpegKids } = useSpawns({ probe: PROBE_AV1 });

    await manager.start({ id: 3, source: LIVE_HLS, dest: DEST });

    const args = firstFfmpegArgs();
    expect(args).toContain('libx264');
    expect(args).toContain('yuv420p');
    expect(args).toContain('aac');
    expect(args).not.toContain('copy');
    expect(ffmpegKids).toHaveLength(1);
  });

  it('falls back to transcoding when ffprobe fails outright', async () => {
    stubGateOn();
    const { ffprobeKids } = useSpawns({ probeFails: true });

    await manager.start({ id: 3, source: LIVE_HLS, dest: DEST });

    expect(ffprobeKids).toHaveLength(1);
    const args = firstFfmpegArgs();
    expect(args).toContain('libx264');
    expect(args).not.toContain('copy');
  });

  it('falls back to transcoding when ffprobe returns unparseable JSON', async () => {
    stubGateOn();
    const { ffmpegKids, ffprobeKids } = useSpawns({});
    ffprobeKids.length = 0;
    spawnMock.mockImplementation((command: string) => {
      const kid = makeFakeChild();
      if (command === 'ffprobe') {
        ffprobeKids.push(kid);
        queueMicrotask(() => {
          kid.stdout.emit('data', Buffer.from('this is not json'));
          closeChild(kid, 0);
        });
      } else {
        ffmpegKids.push(kid);
      }
      return kid;
    });

    await manager.start({ id: 3, source: LIVE_HLS, dest: DEST });

    const args = firstFfmpegArgs();
    expect(args).toContain('libx264');
    expect(args).not.toContain('copy');
  });
});
