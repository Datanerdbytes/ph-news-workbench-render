import { EventEmitter } from 'node:events';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { spawnMock, fsMocks, isolationMock, processKillMock } = vi.hoisted(() => {
  const spawnMock = vi.fn();
  const isolationMock = vi.fn();
  const processKillMock = vi.fn();
  const open = vi.fn(async (filePath: string) => ({
    fd: filePath.endsWith('-video') ? 31 : 32,
    close: vi.fn(async () => {}),
  }));
  const unlink = vi.fn(async () => {});
  const mkfifo = vi.fn(async () => {});
  return {
    spawnMock,
    isolationMock,
    processKillMock,
    fsMocks: {
      open,
      unlink,
      mkfifo,
      constants: { O_WRONLY: 1, O_RDONLY: 0, O_NONBLOCK: 4 },
    },
  };
});

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('./media-egress', () => ({
  // guardedSpawn forwards to the mocked spawn so lifecycle tests keep their
  // child fixtures; signalProcessTree is observable via the processKillMock
  // spy (media-egress.test.ts covers the real negative-pid group kill).
  guardedSpawn: (...args: unknown[]) => spawnMock(...args),
  signalProcessTree: (...args: unknown[]) => processKillMock(...args),
}));
vi.mock('./media-sandbox', () => ({
  // The sandbox is "verified and ready" for the lifecycle tests; the
  // default-deny quarantine test flips it via isolationMock.
  mediaSandboxAvailability: isolationMock,
}));
vi.mock('node:fs/promises', () => ({
  constants: fsMocks.constants,
  open: fsMocks.open,
  unlink: fsMocks.unlink,
  mkfifo: fsMocks.mkfifo,
}));

import {
  assembleRtmpsUrl,
  buildFeederArgs,
  buildPublisherArgs,
  buildPumpArgs,
  buildStagedPumpArgs,
  decideTranscode,
  FIFO_OPEN_TIMEOUT_MS,
  getPumpManager,
  isFacebookIngestUrl,
  REDACTED_KEY,
  redactStreamKey,
  PUBLISHER_SETTLE_GRACE_MS,
  RETRY_BACKOFF_MS,
  STOP_GRACE_MS,
  type VideoStreams,
} from './pump';

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
};

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
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
// DASH-only source: the staged pump pipes this through yt-dlp feeders.
const FB_REPLAY = 'https://www.facebook.com/newsroom/videos/10153231379946729/';
const STREAM_KEY = '1_secret-key-do-not-leak';
const RTMPS_BASE = 'rtmps://live-api-s.facebook.com:443/rtmp/1234567890/';
const DEST = `${RTMPS_BASE}${STREAM_KEY}`;
// The local flv fifo the sandboxed side writes and the publisher reads.
const OUT_FIFO = '/tmp/live-pump-out.flv';

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
 * probe JSON, mkfifo children succeed immediately (unless `mkfifoFails`),
 * ffmpeg children stay silent until the test drives them, and yt-dlp feeder
 * children emit the spawn handshake (or an ENOENT error for the commands
 * listed in `failingFeederCommands`) on the next macrotask.
 *
 * Every child event is scheduled with setTimeout so it fires strictly AFTER
 * the `await guardedSpawn(...)` continuation attached its listeners — under
 * fake timers, advance the clock (see flushChildEvents) to run them.
 */
function useSpawns(
  options: {
    probe?: VideoStreams;
    probeFails?: boolean;
    failingFeederCommands?: string[];
    mkfifoFails?: boolean;
  } = {}
): {
  ffmpegKids: FakeChild[];
  ffprobeKids: FakeChild[];
  mkfifoKids: FakeChild[];
  feederKids: FakeChild[];
} {
  const ffmpegKids: FakeChild[] = [];
  const ffprobeKids: FakeChild[] = [];
  const mkfifoKids: FakeChild[] = [];
  const feederKids: FakeChild[] = [];
  spawnMock.mockImplementation((command: string) => {
    const kid = makeFakeChild();
    if (command === 'ffprobe') {
      ffprobeKids.push(kid);
      setTimeout(() => {
        if (options.probeFails) {
          closeChild(kid, 1);
        } else {
          kid.stdout.emit('data', Buffer.from(buildProbeJson(options.probe ?? PROBE_COPY)));
          closeChild(kid, 0);
        }
      }, 0);
    } else if (command === 'mkfifo') {
      mkfifoKids.push(kid);
      setTimeout(() => closeChild(kid, options.mkfifoFails ? 1 : 0), 0);
    } else if (command === 'ffmpeg') {
      // Per attempt: [0] = the publisher, [1] = the sandboxed source.
      ffmpegKids.push(kid);
    } else {
      feederKids.push(kid);
      if (options.failingFeederCommands?.includes(command)) {
        setTimeout(() => {
          kid.emit(
            'error',
            Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })
          );
        }, 0);
      } else {
        setTimeout(() => kid.emit('spawn'), 0);
      }
    }
    return kid;
  });
  return { ffmpegKids, ffprobeKids, mkfifoKids, feederKids };
}

/**
 * Under fake timers: fires the macrotask child events (ffprobe answers,
 * mkfifo closes, feeder handshakes) scheduled by the mocked spawn — several
 * rounds, because each round's events schedule the next spawn's events.
 * The 1ms step matters: timers registered while a zero-step tick is still
 * draining its microtasks are never picked up by a later zero-step tick.
 */
async function flushChildEvents(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await vi.advanceTimersByTimeAsync(1);
  }
}

/** The mkfifo paths of the most recent attempt, in creation order. */
function latestFifoPaths(): { video: string; audio: string; flv: string } {
  const calls = spawnMock.mock.calls.filter(
    ([command]) => command === 'mkfifo'
  ) as [string, string[]][];
  return {
    video: calls[calls.length - 3][1][2],
    audio: calls[calls.length - 2][1][2],
    flv: calls[calls.length - 1][1][2],
  };
}

function ffmpegArgsList(): string[][] {
  return spawnMock.mock.calls
    .filter(([command]) => command === 'ffmpeg')
    .map((call) => call[1] as string[]);
}

/**
 * ffmpeg spawn args per attempt, in spawn order: the UNSANDBOXED publisher
 * spawns first (it owns the RTMPS dest), the sandboxed source second (it
 * writes the local out fifo).
 */
function ffmpegArgsOf(attempt = 0): { publisher: string[]; source: string[] } {
  const calls = ffmpegArgsList();
  const publisher = calls[attempt * 2];
  const source = calls[attempt * 2 + 1];
  expect(
    publisher,
    `expected the attempt ${attempt + 1} publisher to have been spawned`
  ).toBeDefined();
  expect(
    source,
    `expected the attempt ${attempt + 1} source ffmpeg to have been spawned`
  ).toBeDefined();
  return { publisher, source };
}

/** Start + flush under fake timers: child events fire while the start runs. */
async function startPump(
  request: Parameters<typeof manager.start>[0]
): Promise<Awaited<ReturnType<typeof manager.start>>> {
  const pending = manager.start(request);
  await flushChildEvents();
  return pending;
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
  fsMocks.open.mockReset();
  fsMocks.unlink.mockReset();
  fsMocks.mkfifo.mockReset();
  processKillMock.mockReset();
  // Verified runner present by default; the quarantine test overrides this.
  isolationMock.mockImplementation(() => ({
    available: true,
    reason: null,
  }));
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
  it('copy path over live HLS adds reconnect flags, -re, -c copy, -f flv and puts the flv output fifo last', () => {
    const args = buildPumpArgs({ source: LIVE_HLS, needsTranscode: false });
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
    expect(args[args.length - 1]).toBe('pipe:1');
    // The RTMPS destination moved to the unsandboxed publisher.
    expect(args).not.toContain(DEST);
    expect(args).not.toContain('libx264');
  });

  it('copy path over a plain file source omits the reconnect flags', () => {
    const args = buildPumpArgs({ source: VOD_MP4, needsTranscode: false });
    expect(args).not.toContain('-reconnect');
    expect(args).toContain('-re');
    expect(args[args.length - 1]).toBe('pipe:1');
    // The RTMPS destination moved to the unsandboxed publisher.
    expect(args).not.toContain(DEST);
  });

  it('transcode path swaps -c copy for libx264 + aac + yuv420p and puts the flv output fifo last', () => {
    const args = buildPumpArgs({ source: LIVE_HLS, needsTranscode: true });
    expect(args).toContain('libx264');
    expect(args).toContain('veryfast');
    expect(args).toContain('23');
    expect(args).toContain('yuv420p');
    expect(args).toContain('aac');
    expect(args).toContain('128k');
    expect(args).not.toContain('copy');
    expect(args[args.length - 1]).toBe('pipe:1');
    // The RTMPS destination moved to the unsandboxed publisher.
    expect(args).not.toContain(DEST);
  });
});

describe('FIFO output writing', () => {
  it('allows both source modes to write their pre-created output pipe without prompting', () => {
    expect(buildPumpArgs({ source: LIVE_HLS, needsTranscode: false })).toContain('-y');
    expect(buildStagedPumpArgs({ videoFifo: '/tmp/v', audioFifo: '/tmp/a' })).toContain('-y');
  });
});

describe('buildPublisherArgs', () => {
  it('reads the flv fifo and copies it to the RTMPS ingest URL, dest last', () => {
    expect(buildPublisherArgs({ flvFifo: OUT_FIFO, dest: DEST })).toEqual([
      '-f',
      'flv',
      '-i',
      OUT_FIFO,
      '-c',
      'copy',
      '-f',
      'flv',
      DEST,
    ]);
  });
});

describe('isFacebookIngestUrl', () => {
  it('accepts rtmps URLs whose host is a Facebook ingest endpoint', () => {
    expect(isFacebookIngestUrl(DEST)).toBe(true);
    expect(isFacebookIngestUrl('rtmps://live-api-s.facebook.com:443/rtmp/1/key')).toBe(true);
    expect(isFacebookIngestUrl('rtmp://ingest.example.facebook.com/live')).toBe(true);
  });

  it('rejects other protocols, non-Facebook hosts and unparseable strings', () => {
    expect(isFacebookIngestUrl('https://live-api-s.facebook.com/rtmp/1/key')).toBe(false);
    expect(isFacebookIngestUrl('rtmps://live-api-s.example.com/rtmp/1/key')).toBe(false);
    expect(isFacebookIngestUrl('not a url at all')).toBe(false);
  });
});

describe('buildStagedPumpArgs', () => {
  it('builds -re with both fifo inputs, copies video, transcodes audio to aac and puts the flv output fifo last', () => {
    const args = buildStagedPumpArgs({
      videoFifo: '/tmp/pump-video',
      audioFifo: '/tmp/pump-audio',
    });
    expect(args.slice(0, 5)).toEqual([
      '-re',
      '-i',
      '/tmp/pump-video',
      '-i',
      '/tmp/pump-audio',
    ]);
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args).toContain('128k');
    expect(args[args.indexOf('-f') + 1]).toBe('flv');
    expect(args[args.length - 1]).toBe('pipe:1');
    // The RTMPS destination moved to the unsandboxed publisher.
    expect(args).not.toContain(DEST);
    expect(args).not.toContain('libx264');
    // Video is copied via -c:v; audio is never passed through as-is.
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'copy']));
    expect(args.filter((arg) => arg === 'copy')).toHaveLength(1);
  });
});

describe('buildFeederArgs', () => {
  it('video feeder prefers H.264 at ≤1080p, writes media bytes to stdout and keeps the URL one argv element', () => {
    const args = buildFeederArgs(FB_REPLAY, 'video');
    expect(args[0]).toBe('-f');
    expect(args[1]).toBe(
      'bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]/bv*'
    );
    expect(args).toEqual(
      expect.arrayContaining([
        '--no-playlist',
        '--js-runtimes',
        'node',
        '--no-part',
        '--newline',
      ])
    );
    expect(args[args.indexOf('-o') + 1]).toBe('-');
    expect(args.at(-1)).toBe(FB_REPLAY);
    expect(args.filter((arg) => arg === FB_REPLAY)).toHaveLength(1);
  });

  it('audio feeder selects the best audio-only format and mirrors the shared yt-dlp flags', () => {
    const args = buildFeederArgs(FB_REPLAY, 'audio');
    expect(args[0]).toBe('-f');
    expect(args[1]).toBe('ba/b');
    expect(args).toEqual(
      expect.arrayContaining([
        '--no-playlist',
        '--js-runtimes',
        'node',
        '--no-part',
        '--newline',
        '-o',
        '-',
      ])
    );
    expect(args.at(-1)).toBe(FB_REPLAY);
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

    const result = await manager.start({ id: 9, source: LIVE_HLS,dest: DEST });

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

    const result = await manager.start({ id: 7, source: LIVE_HLS,dest: DEST });

    expect(result).toEqual({ ok: true });
    // Two ffmpeg kids per attempt: the publisher and the sandboxed source.
    expect(ffmpegKids).toHaveLength(2);
    const status = manager.status(7);
    expect(status.running).toBe(true);
    expect(status.startedAt).toBeInstanceOf(Date);
    expect(status.error).toBeNull();
  });

  it('a second start for a live pump is rejected without spawning again', async () => {
    stubGateOn();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await manager.start({ id: 7, source: LIVE_HLS,dest: DEST });

    const second = await manager.start({ id: 7, source: LIVE_HLS,dest: DEST });

    expect(second).toEqual({
      ok: false,
      reason: 'already_running',
      error: expect.any(String),
    });
    expect(ffmpegKids).toHaveLength(2);
  });

  it('an unknown id reports not running with no startedAt and no error', () => {
    expect(manager.status('nope')).toEqual({
      running: false,
      startedAt: null,
      error: null,
      retrying: false,
    });
  });

  it('stop signals the source ffmpeg and publisher with SIGINT and SIGKILLs both after the 5s grace period', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await startPump({ id: 7, source: LIVE_HLS,dest: DEST });

    expect(manager.stop(7)).toEqual({ ok: true, wasRunning: true });
    // No feeders (direct mode): the source ffmpeg is signalled first, then
    // the publisher — both through signalProcessTree.
    const signalOrder = (child: FakeChild, signal: string) =>
      processKillMock.mock.calls.findIndex(
        ([target, sent]) => target === child && sent === signal
      );
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[1], 'SIGINT');
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[0], 'SIGINT');
    expect(signalOrder(ffmpegKids[1], 'SIGINT')).toBeLessThan(
      signalOrder(ffmpegKids[0], 'SIGINT')
    );
    expect(processKillMock).not.toHaveBeenCalledWith(ffmpegKids[1], 'SIGKILL');

    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(processKillMock).not.toHaveBeenCalledWith(ffmpegKids[1], 'SIGKILL');

    await vi.advanceTimersByTimeAsync(1);
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[1], 'SIGKILL');
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[0], 'SIGKILL');

    // The source ffmpeg unwinding settles the attempt; nothing retries.
    closeChild(ffmpegKids[1], null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ffmpegKids).toHaveLength(2);
    const status = manager.status(7);
    expect(status.running).toBe(false);
    expect(status.error).toBeNull();
  });

  it('a pump that closes cleanly before the grace period is never SIGKILLed', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await startPump({ id: 7, source: LIVE_HLS,dest: DEST });

    manager.stop(7);
    // The source side EOFs and exits 0 within the grace period.
    closeChild(ffmpegKids[1], 0);
    // The close already tore the attempt down (the publisher was killed as
    // part of it); the grace-period SIGKILL timer must add nothing further.
    const callsAtTeardown = processKillMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + 60_000);

    expect(processKillMock).not.toHaveBeenCalledWith(ffmpegKids[1], 'SIGKILL');
    expect(processKillMock.mock.calls.length).toBe(callsAtTeardown);
    expect(manager.status(7).running).toBe(false);
  });

  it('stopping an unknown id is an idempotent no-op', () => {
    expect(manager.stop(1234)).toEqual({ ok: true, wasRunning: false });
  });
});

describe('PumpManager publisher leg', () => {
  it('does not publish when direct pipe creation fails', async () => {
    stubGateOn();
    const { ffmpegKids } = useSpawns({ mkfifoFails: true });
    const result = await manager.start({ id: 44, source: LIVE_HLS,dest: DEST });
    expect(result).toMatchObject({ ok: false, reason: 'spawn_failed' });
    expect(ffmpegKids).toHaveLength(0);
    expect(manager.status(44).running).toBe(false);
  });

  it('honors a stop during direct pipe creation and cleans up without publishing', async () => {
    stubGateOn();
    const { ffmpegKids } = useSpawns();
    const spawnImpl = spawnMock.getMockImplementation()!;
    spawnMock.mockImplementation((command: string, args: string[], options: unknown) => {
      const child = spawnImpl(command, args, options);
      if (command === 'mkfifo') manager.stop(45);
      return child;
    });
    await manager.start({ id: 45, source: LIVE_HLS, dest: DEST });
    expect(ffmpegKids).toHaveLength(0);
    expect(fsMocks.unlink).toHaveBeenCalledWith(
      expect.stringMatching(/live-pump-out-.+\.flv$/)
    );
    expect(manager.status(45).running).toBe(false);
  });

  it('creates the direct output pipe before publishing and removes it on exit', async () => {
    stubGateOn();
    const { ffmpegKids, mkfifoKids } = useSpawns();
    let pipeCreated = false;
    const spawnImpl = spawnMock.getMockImplementation()!;
    spawnMock.mockImplementation((command: string, args: string[], options: unknown) => {
      if (command === 'ffmpeg') expect(pipeCreated).toBe(true);
      const child = spawnImpl(command, args, options);
      if (command === 'mkfifo') {
        child.once('close', (code: number) => { pipeCreated = code === 0; });
      }
      return child;
    });

    const result = await manager.start({ id: 43, source: LIVE_HLS,dest: DEST });

    expect(result).toEqual({ ok: true });
    expect(mkfifoKids).toHaveLength(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'mkfifo',
      ['-m', '0600', expect.stringMatching(/live-pump-out-.+\.flv$/)],
      expect.anything()
    );
    closeChild(ffmpegKids[1], 0);
    expect(fsMocks.unlink).toHaveBeenCalledWith(
      expect.stringMatching(/live-pump-out-.+\.flv$/)
    );
  });

  it('spawns the unsandboxed publisher first (reading the out fifo, dest last) and the sandboxed source second', async () => {
    stubGateOn();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });

    await manager.start({ id: 40, source: LIVE_HLS,dest: DEST });

    expect(ffmpegKids).toHaveLength(2);
    const { publisher, source } = ffmpegArgsOf();
    // The publisher reads the pump's out fifo and copies to the ingest URL.
    expect(publisher).toEqual(
      buildPublisherArgs({
        flvFifo: expect.stringMatching(/live-pump-out-.+\.flv$/),
        dest: DEST,
      })
    );
    // It is the one child spawned detached outside the sandbox.
    const publisherCall = spawnMock.mock.calls.find(
      ([command, args]) => command === 'ffmpeg' && (args as string[]).at(-1) === DEST
    );
    expect(publisherCall?.[2]).toMatchObject({ detached: true });
    // The source never sees the dest — it writes the local fifo instead.
    expect(source).toEqual(
      buildPumpArgs({ source: LIVE_HLS, needsTranscode: false })
    );
    expect(source).not.toContain(DEST);

    // Spawn order: the publisher's pending read-end pairs with the source's
    // output open, so it must exist before the sandboxed side spawns.
    const publisherSpawn = spawnMock.mock.invocationCallOrder[
      spawnMock.mock.calls.findIndex(
        ([command, args]) => command === 'ffmpeg' && (args as string[]).at(-1) === DEST
      )
    ];
    const sourceSpawn = spawnMock.mock.invocationCallOrder[
      spawnMock.mock.calls.findIndex(
        ([command, args]) => command === 'ffmpeg' && (args as string[]).at(-1) === 'pipe:1'
      )
    ];
    expect(publisherSpawn).toBeLessThan(sourceSpawn);
  });

  it('the publisher exiting non-zero fails the attempt, SIGKILLs the source and retries', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await startPump({ id: 41, source: LIVE_HLS,dest: DEST });

    closeChild(ffmpegKids[0], 1);

    // The publisher's death waits one grace beat for the source side to say
    // why, so nothing is killed yet.
    expect(processKillMock).not.toHaveBeenCalledWith(ffmpegKids[1], 'SIGKILL');
    await vi.advanceTimersByTimeAsync(PUBLISHER_SETTLE_GRACE_MS);

    // The dead publisher settles the attempt; the sandboxed source is killed.
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[1], 'SIGKILL');
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[0], 'SIGKILL');

    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[0]);
    await flushChildEvents();
    // A fresh publisher + source pair for the retried attempt.
    expect(ffmpegKids).toHaveLength(4);
    const retry = ffmpegArgsOf(1);
    expect(retry.publisher.at(-1)).toBe(DEST);
    expect(retry.source.at(-1)).toBe('pipe:1');

    // The retried attempt ends cleanly when the new source EOFs.
    closeChild(ffmpegKids[3], 0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ffmpegKids).toHaveLength(4);
    const status = manager.status(41);
    expect(status.running).toBe(false);
    expect(status.error).toBeNull();
  });

  it('the publisher exiting 0 is a no-op: the source side still settles the attempt', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await startPump({ id: 42, source: LIVE_HLS,dest: DEST });

    // Facebook closed cleanly — the attempt keeps running until the source
    // side EOFs.
    closeChild(ffmpegKids[0], 0);
    expect(manager.status(42).running).toBe(true);

    closeChild(ffmpegKids[1], 0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ffmpegKids).toHaveLength(2);
    const status = manager.status(42);
    expect(status.running).toBe(false);
    expect(status.error).toBeNull();
  });

  it('a dead publisher quotes the source side that explains it, not just the exit code', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await startPump({ id: 43, source: LIVE_HLS, dest: DEST });

    // Every attempt: the publisher dies first because the flv fifo stays
    // empty, then the source reports the actual cause a beat later. This is
    // the Fly.io failure shape — a sandbox network denial surfaced only as
    // "the RTMPS publisher exited with code 1".
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
      const publisher = ffmpegKids[attempt * 2];
      const source = ffmpegKids[attempt * 2 + 1];
      closeChild(publisher, 1);
      stderrLine(
        source,
        'https://manifest.googlevideo.com/api/manifest: Server returned 403 Forbidden (access denied)\n'
      );
      closeChild(source, 1);
      await vi.advanceTimersByTimeAsync(
        attempt < RETRY_BACKOFF_MS.length ? RETRY_BACKOFF_MS[attempt] : 60_000
      );
      await flushChildEvents();
    }

    const status = manager.status(43);
    expect(status.error).toContain('403 Forbidden');
    expect(status.error).toContain('Source stderr:');
    // The source explained the failure, so the publisher's exit code — a
    // symptom — is not even needed.
    expect(status.error).not.toContain('Publisher stderr:');
  });

  it('labels the publisher tail when the source side dies without a word', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await startPump({ id: 44, source: LIVE_HLS, dest: DEST });

    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
      const publisher = ffmpegKids[attempt * 2];
      const source = ffmpegKids[attempt * 2 + 1];
      stderrLine(publisher, 'rtmp://live-api-s.facebook.com:443: I/O error\n');
      closeChild(publisher, 1);
      await vi.advanceTimersByTimeAsync(PUBLISHER_SETTLE_GRACE_MS);
      closeChild(source, 1);
      await vi.advanceTimersByTimeAsync(
        attempt < RETRY_BACKOFF_MS.length ? RETRY_BACKOFF_MS[attempt] : 60_000
      );
      await flushChildEvents();
    }

    const status = manager.status(44);
    expect(status.error).toContain('Source stderr: none');
    expect(status.error).toContain('Publisher stderr:');
    expect(status.error).toContain('I/O error');
  });
});

describe('PumpManager retry policy', () => {
  it('exit 1 mid-stream retries up to 3 times with 2s/4s/8s backoff, then records the last error', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await startPump({ id: 7, source: LIVE_HLS,dest: DEST });
    expect(ffmpegKids).toHaveLength(2);

    // Attempt 1 fails → 2s backoff.
    closeChild(ffmpegKids[1], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[0] - 1);
    expect(ffmpegKids).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushChildEvents();
    expect(ffmpegKids).toHaveLength(4);

    // Attempt 2 fails → 4s backoff.
    closeChild(ffmpegKids[3], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[1] - 1);
    expect(ffmpegKids).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    await flushChildEvents();
    expect(ffmpegKids).toHaveLength(6);

    // Attempt 3 fails → 8s backoff.
    closeChild(ffmpegKids[5], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[2] - 1);
    expect(ffmpegKids).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1);
    await flushChildEvents();
    expect(ffmpegKids).toHaveLength(8);

    // Attempt 4 (the third retry) fails → give up.
    closeChild(ffmpegKids[7], 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ffmpegKids).toHaveLength(8);

    const status = manager.status(7);
    expect(status.running).toBe(false);
    expect(status.error).toContain('code 1');
    expect(status.error).toContain('retries');
  });

  it('a pump that recovered on a retry ends cleanly with no recorded error', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await startPump({ id: 7, source: LIVE_HLS,dest: DEST });

    closeChild(ffmpegKids[1], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[0]);
    await flushChildEvents();
    expect(ffmpegKids).toHaveLength(4);
    closeChild(ffmpegKids[3], 0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ffmpegKids).toHaveLength(4);
    const status = manager.status(7);
    expect(status.running).toBe(false);
    expect(status.error).toBeNull();
  });

  it('exit 0 (input ended cleanly) never schedules a retry', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await startPump({ id: 7, source: LIVE_HLS,dest: DEST });

    closeChild(ffmpegKids[1], 0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ffmpegKids).toHaveLength(2);
    const status = manager.status(7);
    expect(status.running).toBe(false);
    expect(status.error).toBeNull();
  });

  it('a retry-waiting pump still refuses a second start', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await startPump({ id: 7, source: LIVE_HLS,dest: DEST });

    closeChild(ffmpegKids[1], 1);
    const second = await manager.start({ id: 7, source: LIVE_HLS,dest: DEST });

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
    await startPump({ id: 7, source: LIVE_HLS,dest: DEST });

    stderrLine(ffmpegKids[1], 'rtmp://ingest: command "publish" failed: Already publishing');
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[1], 'SIGKILL');
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[0], 'SIGKILL');
    closeChild(ffmpegKids[1], 1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ffmpegKids).toHaveLength(2);
    const status = manager.status(7);
    expect(status.running).toBe(false);
    expect(status.error).toContain('Already publishing');
  });

  it('"Connection refused" from the ingest endpoint is also treated as fatal', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await startPump({ id: 7, source: LIVE_HLS,dest: DEST });

    stderrLine(ffmpegKids[1], 'tcp://live-api-s.facebook.com:443: Connection refused');
    closeChild(ffmpegKids[1], 1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ffmpegKids).toHaveLength(2);
    expect(manager.status(7).error).toContain('Connection refused');
  });
});

describe('PumpManager key secrecy', () => {
  it('stderr tails and recorded errors contain *** instead of the stream key', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids } = useSpawns({ probe: PROBE_COPY });
    await startPump({ id: 11, source: LIVE_HLS,dest: DEST });

    stderrLine(
      ffmpegKids[1],
      `handshake with ${DEST} failed\nbad auth for ${STREAM_KEY}\navc: connection lost`
    );
    closeChild(ffmpegKids[1], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[0]);
    await flushChildEvents();
    stderrLine(ffmpegKids[3], `retry also failed for ${STREAM_KEY}`);
    closeChild(ffmpegKids[3], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[1]);
    await flushChildEvents();
    stderrLine(ffmpegKids[5], `third failure on ${STREAM_KEY}`);
    closeChild(ffmpegKids[5], 1);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[2]);
    await flushChildEvents();
    closeChild(ffmpegKids[7], 1);
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
    await startPump({ id: 11, source: LIVE_HLS,dest: DEST });

    stderrLine(ffmpegKids[1], `publish rejected for ${STREAM_KEY}: Already publishing`);
    closeChild(ffmpegKids[1], 1);
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

    await manager.start({ id: 3, source: LIVE_HLS,dest: DEST });

    expect(ffprobeKids).toHaveLength(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-of', 'json', LIVE_HLS],
      expect.anything()
    );
    const { source } = ffmpegArgsOf();
    expect(source).toContain('-reconnect');
    const cIndex = source.indexOf('-c');
    expect(source[cIndex + 1]).toBe('copy');
    expect(source).not.toContain('libx264');
    expect(source[source.length - 1]).toBe('pipe:1');
    // The RTMPS destination moved to the unsandboxed publisher.
    expect(source).not.toContain(DEST);
  });

  it('switches to transcoding when the probe reports av1', async () => {
    stubGateOn();
    const { ffmpegKids } = useSpawns({ probe: PROBE_AV1 });

    await manager.start({ id: 3, source: LIVE_HLS,dest: DEST });

    const { source } = ffmpegArgsOf();
    expect(source).toContain('libx264');
    expect(source).toContain('yuv420p');
    expect(source).toContain('aac');
    expect(source).not.toContain('copy');
    expect(ffmpegKids).toHaveLength(2);
  });

  it('falls back to transcoding when ffprobe fails outright', async () => {
    stubGateOn();
    const { ffprobeKids } = useSpawns({ probeFails: true });

    await manager.start({ id: 3, source: LIVE_HLS,dest: DEST });

    expect(ffprobeKids).toHaveLength(1);
    const { source } = ffmpegArgsOf();
    expect(source).toContain('libx264');
    expect(source).not.toContain('copy');
  });

  it('falls back to transcoding when ffprobe returns unparseable JSON', async () => {
    stubGateOn();
    const { ffmpegKids, ffprobeKids } = useSpawns({});
    ffprobeKids.length = 0;
    spawnMock.mockImplementation((command: string) => {
      const kid = makeFakeChild();
      if (command === 'ffprobe') {
        ffprobeKids.push(kid);
        setTimeout(() => {
          kid.stdout.emit('data', Buffer.from('this is not json'));
          closeChild(kid, 0);
        }, 0);
      } else if (command === 'mkfifo') {
        setTimeout(() => closeChild(kid, 0), 0);
      } else {
        ffmpegKids.push(kid);
      }
      return kid;
    });

    await manager.start({ id: 3, source: LIVE_HLS,dest: DEST });

    const { source } = ffmpegArgsOf();
    expect(source).toContain('libx264');
    expect(source).not.toContain('copy');
  });
});

describe('PumpManager staged mode', () => {
  it('start(mode: staged) creates a 0600 fifo trio, spawns the publisher then sandboxed ffmpeg, then two yt-dlp feeders whose stdout is the fifo fd — and never probes', async () => {
    stubGateOn();
    const { ffmpegKids, ffprobeKids, mkfifoKids, feederKids } = useSpawns();

    const result = await manager.start({
      id: 21,
      source: FB_REPLAY,
        mode: 'staged',
      dest: DEST,
    });

    expect(result).toEqual({ ok: true });
    // Staged skips ffprobe — the pipes are unprobeable.
    expect(ffprobeKids).toHaveLength(0);
    // mkfifo -m 0600 <path>, one per fifo: video, audio AND the flv output.
    expect(mkfifoKids).toHaveLength(3);
    const mkfifoCalls = spawnMock.mock.calls.filter(
      ([command]) => command === 'mkfifo'
    ) as [string, string[]][];
    expect(mkfifoCalls[0][1]).toEqual([
      '-m',
      '0600',
      expect.stringContaining('-video'),
    ]);
    expect(mkfifoCalls[1][1]).toEqual([
      '-m',
      '0600',
      expect.stringContaining('-audio'),
    ]);
    expect(mkfifoCalls[2][1]).toEqual([
      '-m',
      '0600',
      expect.stringContaining('-flv'),
    ]);

    expect(ffmpegKids).toHaveLength(2);
    const fifos = latestFifoPaths();
    // The UNSANDBOXED publisher reads the staged flv fifo and copies it to
    // the ingest URL (dest last).
    expect(ffmpegArgsOf().publisher).toEqual([
      '-f',
      'flv',
      '-i',
      fifos.flv,
      '-c',
      'copy',
      '-f',
      'flv',
      DEST,
    ]);
    // The sandboxed source: paced copy of both input fifos into stdout
    // (`pipe:1` — its fd is paired with the flv fifo's write-end).
    const sourceArgs = ffmpegArgsOf().source;
    expect(sourceArgs.slice(0, 5)).toEqual([
      '-re',
      '-i',
      fifos.video,
      '-i',
      fifos.audio,
    ]);
    expect(sourceArgs[sourceArgs.length - 1]).toBe('pipe:1');
    expect(sourceArgs).not.toContain(DEST);

    expect(feederKids).toHaveLength(2);
    const feederCalls = spawnMock.mock.calls.filter(
      ([command]) => command === 'yt-dlp'
    ) as [string, string[], { stdio: unknown[] }][];
    expect(feederCalls[0][0]).toBe('yt-dlp');
    expect(feederCalls[0][1]).toEqual([
      '-f',
      'bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]/bv*',
      '--no-playlist',
      '--js-runtimes',
      'node',
      '--no-part',
      '--newline',
      '-o',
      '-',
      FB_REPLAY,
    ]);
    expect(feederCalls[1][1]).toEqual([
      '-f',
      'ba/b',
      '--no-playlist',
      '--js-runtimes',
      'node',
      '--no-part',
      '--newline',
      '-o',
      '-',
      FB_REPLAY,
    ]);
    // The feeder's stdout IS the fifo write-end fd (video 31, audio 32).
    expect(feederCalls[0][2].stdio).toEqual(['ignore', 31, 'pipe']);
    expect(feederCalls[1][2].stdio).toEqual(['ignore', 32, 'pipe']);

    // ORDERING (regression guard — opening both write-ends up front
    // deadlocks ffmpeg's sequential open+probe of its inputs):
    // publisher → source ffmpeg → video open → video feeder → audio open →
    // audio feeder.
    const spawnOrder = (callIndex: number) =>
      spawnMock.mock.invocationCallOrder[callIndex];
    const callIndexOf = (
      predicate: (call: unknown[]) => boolean
    ) => spawnMock.mock.calls.findIndex(predicate);
    const publisherCallIndex = callIndexOf(
      ([command, args]) => command === 'ffmpeg' && (args as string[]).at(-1) === DEST
    );
    const sourceCallIndex = callIndexOf(
      ([command, args]) => command === 'ffmpeg' && (args as string[]).at(-1) === 'pipe:1'
    );
    // The publisher spawns before the sandboxed side so its pending read-end
    // pairs with the write-end opened below.
    expect(spawnOrder(publisherCallIndex)).toBeLessThan(spawnOrder(sourceCallIndex));
    // The flv write-end open pairs with the publisher's pending read-end and
    // must complete before the sandboxed ffmpeg spawns with that fd.
    expect(fsMocks.open.mock.invocationCallOrder[0]).toBeLessThan(
      spawnOrder(sourceCallIndex)
    );
    // The video feeder spawns right after the video open resolves — its bytes
    // are what lets ffmpeg's probe of v.fifo complete.
    const feederCallIndexes = spawnMock.mock.calls.reduce<number[]>(
      (acc, call, index) => (call[0] === 'yt-dlp' ? [...acc, index] : acc),
      []
    );
    expect(fsMocks.open.mock.invocationCallOrder[1]).toBeLessThan(
      spawnOrder(feederCallIndexes[0])
    );
    // a.fifo is only opened once the video feeder exists.
    expect(spawnOrder(feederCallIndexes[0])).toBeLessThan(
      fsMocks.open.mock.invocationCallOrder[2]
    );
    // The audio feeder spawns right after the audio open resolves.
    expect(fsMocks.open.mock.invocationCallOrder[2]).toBeLessThan(
      spawnOrder(feederCallIndexes[1])
    );
    // The opens interleave per-fifo: flv (paired with the publisher) first,
    // then video, then audio.
    expect(fsMocks.open.mock.calls.map((call) => call[0])).toEqual([
      fifos.flv,
      fifos.video,
      fifos.audio,
    ]);

    // The parent closed its copies of the write-end fds after spawning.
    expect(fsMocks.open).toHaveBeenCalledTimes(3);
    expect(fsMocks.open).toHaveBeenCalledWith(fifos.flv, 1);
    expect(fsMocks.open).toHaveBeenCalledWith(fifos.video, 1);
    expect(fsMocks.open).toHaveBeenCalledWith(fifos.audio, 1);

    expect(manager.status(21).running).toBe(true);
  });

  it('falls back to the venv python -m yt_dlp when the yt-dlp binary cannot spawn', async () => {
    stubGateOn();
    vi.stubEnv('YTDLP_PYTHON', '/venv/python');
    const { feederKids } = useSpawns({ failingFeederCommands: ['yt-dlp'] });

    const result = await manager.start({
      id: 21,
      source: FB_REPLAY,
        mode: 'staged',
      dest: DEST,
    });

    expect(result).toEqual({ ok: true });
    // One failed yt-dlp attempt + one python fallback per feeder.
    const pythonCalls = spawnMock.mock.calls.filter(
      ([command]) => command === '/venv/python'
    ) as [string, string[], { stdio: unknown[] }][];
    expect(pythonCalls).toHaveLength(2);
    expect(pythonCalls[0][1].slice(0, 4)).toEqual(['-m', 'yt_dlp', '-f', 'bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]/bv*']);
    expect(pythonCalls[0][2].stdio).toEqual(['ignore', 31, 'pipe']);
    expect(pythonCalls[1][1].slice(0, 4)).toEqual(['-m', 'yt_dlp', '-f', 'ba/b']);
    expect(pythonCalls[1][2].stdio).toEqual(['ignore', 32, 'pipe']);
    expect(feederKids).toHaveLength(4);
  });

  it('a feeder dying non-zero kills the rest of the attempt (publisher included), unlinks the fifo trio and retries with a fresh one', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids, feederKids, mkfifoKids } = useSpawns();
    await startPump({
      id: 22,
      source: FB_REPLAY,
        mode: 'staged',
      dest: DEST,
    });
    expect(mkfifoKids).toHaveLength(3);
    const firstFifos = latestFifoPaths();
    expect(fsMocks.unlink).not.toHaveBeenCalled();

    feederKids[0].emit('close', 1, null);

    // The rest of the attempt is torn down immediately.
    expect(processKillMock).toHaveBeenCalledWith(feederKids[1], 'SIGKILL');
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[0], 'SIGKILL');
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[1], 'SIGKILL');
    expect(fsMocks.unlink).toHaveBeenCalledWith(firstFifos.video);
    expect(fsMocks.unlink).toHaveBeenCalledWith(firstFifos.audio);
    expect(fsMocks.unlink).toHaveBeenCalledWith(firstFifos.flv);

    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[0]);
    // Fresh fifos need their mkfifo children to complete before the rest of
    // the staged setup runs.
    await flushChildEvents();

    // A full teardown + fresh spawn: new fifos, new publisher, new ffmpeg,
    // new feeders.
    expect(mkfifoKids).toHaveLength(6);
    const secondFifos = latestFifoPaths();
    expect(secondFifos.video).not.toBe(firstFifos.video);
    expect(secondFifos.audio).not.toBe(firstFifos.audio);
    expect(secondFifos.flv).not.toBe(firstFifos.flv);
    expect(ffmpegKids).toHaveLength(4);
    expect(feederKids).toHaveLength(4);
  });

  it('a feeder bot-check on stderr fails the pump without retries and unlinks the fifo trio', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids, feederKids } = useSpawns();
    await startPump({
      id: 23,
      source: FB_REPLAY,
        mode: 'staged',
      dest: DEST,
    });

    feederKids[0].stderr.emit(
      'data',
      Buffer.from(
        "ERROR: [facebook] 10153231379946729: Sign in to confirm you're not a bot.\n"
      )
    );

    // Fatal: everything is killed, nothing retries.
    expect(processKillMock).toHaveBeenCalledWith(feederKids[0], 'SIGKILL');
    expect(processKillMock).toHaveBeenCalledWith(feederKids[1], 'SIGKILL');
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[0], 'SIGKILL');
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[1], 'SIGKILL');
    closeChild(ffmpegKids[1], null);
    feederKids[0].emit('close', 1, null);
    feederKids[1].emit('close', 1, null);
    const fifos = latestFifoPaths();
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.video);
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.audio);
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.flv);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(ffmpegKids).toHaveLength(2);
    expect(feederKids).toHaveLength(2);
    const status = manager.status(23);
    expect(status.running).toBe(false);
    expect(status.error).toContain('video feeder');
    expect(status.error).toContain('sign in');
  });

  it('stop signals the feeders (first), then the source ffmpeg, then the publisher with SIGINT — and SIGKILLs all after the grace period', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids, feederKids } = useSpawns();
    await startPump({
      id: 24,
      source: FB_REPLAY,
        mode: 'staged',
      dest: DEST,
    });

    expect(manager.stop(24)).toEqual({ ok: true, wasRunning: true });
    const signalOrder = (child: FakeChild, signal: string) =>
      processKillMock.mock.calls.findIndex(
        ([target, sent]) => target === child && sent === signal
      );
    expect(processKillMock).toHaveBeenCalledWith(feederKids[0], 'SIGINT');
    expect(processKillMock).toHaveBeenCalledWith(feederKids[1], 'SIGINT');
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[1], 'SIGINT');
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[0], 'SIGINT');
    expect(signalOrder(feederKids[0], 'SIGINT')).toBeLessThan(
      signalOrder(ffmpegKids[1], 'SIGINT')
    );
    expect(signalOrder(ffmpegKids[1], 'SIGINT')).toBeLessThan(
      signalOrder(ffmpegKids[0], 'SIGINT')
    );

    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(processKillMock).not.toHaveBeenCalledWith(feederKids[0], 'SIGKILL');
    await vi.advanceTimersByTimeAsync(1);
    expect(processKillMock).toHaveBeenCalledWith(feederKids[0], 'SIGKILL');
    expect(processKillMock).toHaveBeenCalledWith(feederKids[1], 'SIGKILL');
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[1], 'SIGKILL');
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[0], 'SIGKILL');

    // ffmpeg unwinds after the SIGINT → the fifo trio is unlinked and the
    // pump reports a clean user stop.
    closeChild(ffmpegKids[1], null);
    const fifos = latestFifoPaths();
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.video);
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.audio);
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.flv);
    const status = manager.status(24);
    expect(status.running).toBe(false);
    expect(status.error).toBeNull();
  });

  it('a staged broadcast that ends cleanly (feeders exit 0, ffmpeg exit 0) unlinks the fifo trio and stops without an error', async () => {
    stubGateOn();
    const { ffmpegKids, feederKids } = useSpawns();
    await manager.start({
      id: 25,
      source: FB_REPLAY,
        mode: 'staged',
      dest: DEST,
    });

    // A finished VOD: both feeders finish their side, ffmpeg EOFs and exits 0.
    feederKids[0].emit('close', 0, null);
    feederKids[1].emit('close', 0, null);
    closeChild(ffmpegKids[1], 0);

    const fifos = latestFifoPaths();
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.video);
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.audio);
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.flv);
    expect(ffmpegKids).toHaveLength(2);
    const status = manager.status(25);
    expect(status.running).toBe(false);
    expect(status.error).toBeNull();
  });

  it('an explicit mode: "direct" still probes the source and builds the copy args against the out fifo', async () => {
    stubGateOn();
    const { ffprobeKids } = useSpawns({ probe: PROBE_COPY });

    const result = await manager.start({
      id: 26,
      source: LIVE_HLS,
        mode: 'direct',
      dest: DEST,
    });

    expect(result).toEqual({ ok: true });
    expect(ffprobeKids).toHaveLength(1);
    const { source } = ffmpegArgsOf();
    expect(source).toContain('-re');
    expect(source[source.indexOf('-c') + 1]).toBe('copy');
    expect(source).not.toContain('libx264');
    expect(source[source.length - 1]).toBe('pipe:1');
    // The RTMPS destination moved to the unsandboxed publisher.
    expect(source).not.toContain(DEST);
  });

  it('a probe-phase timeout (slow CDN) is transient: the start succeeds and the attempt retries with a fresh fifo trio', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids, feederKids, mkfifoKids } = useSpawns();
    // The flv write-end never pairs — the publisher never opens its read-end,
    // simulating wedged publisher startup past the per-phase deadline.
    fsMocks.open.mockImplementationOnce(() => new Promise(() => {}));

    const pendingStart = manager.start({
      id: 28,
      source: FB_REPLAY,
        mode: 'staged',
      dest: DEST,
    });
    await vi.advanceTimersByTimeAsync(FIFO_OPEN_TIMEOUT_MS);

    // NOT spawn_failed — the attempt settled into the retry state machine.
    const result = await pendingStart;
    expect(result).toEqual({ ok: true });
    expect(mkfifoKids).toHaveLength(3);
    // Only the publisher was spawned before the write-end open hung.
    expect(ffmpegKids).toHaveLength(1);
    expect(manager.status(28).running).toBe(false);

    // The timed-out attempt was fully torn down: pending write-end open
    // rescued non-blocking, fifo trio unlinked, children killed.
    const firstFifos = latestFifoPaths();
    expect(fsMocks.unlink).toHaveBeenCalledWith(firstFifos.video);
    expect(fsMocks.unlink).toHaveBeenCalledWith(firstFifos.audio);
    expect(fsMocks.unlink).toHaveBeenCalledWith(firstFifos.flv);
    expect(fsMocks.open).toHaveBeenCalledWith(firstFifos.video, 4); // O_RDONLY | O_NONBLOCK
    expect(processKillMock).toHaveBeenCalledWith(ffmpegKids[0], 'SIGKILL');

    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[0]);
    await flushChildEvents();

    // Fresh trio, fresh publisher, fresh ffmpeg, fresh feeders — the download
    // restarts from zero.
    expect(mkfifoKids).toHaveLength(6);
    const secondFifos = latestFifoPaths();
    expect(secondFifos.video).not.toBe(firstFifos.video);
    expect(ffmpegKids).toHaveLength(3);
    expect(feederKids).toHaveLength(2);
    expect(manager.status(28).running).toBe(true);
  });

  it('a first attempt with no working yt-dlp (feeder ENOENT for every candidate) reports spawn_failed without retrying', async () => {
    stubGateOn();
    vi.useFakeTimers();
    vi.stubEnv('YTDLP_PYTHON', '/venv/python');
    const { feederKids, mkfifoKids } = useSpawns({
      failingFeederCommands: ['yt-dlp', '/venv/python'],
    });

    const result = await startPump({
      id: 29,
      source: FB_REPLAY,
        mode: 'staged',
      dest: DEST,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'spawn_failed',
      error: expect.stringContaining('video feeder'),
    });
    expect(mkfifoKids).toHaveLength(3);
    // The half-built attempt was torn down and nothing retries.
    const fifos = latestFifoPaths();
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.video);
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.audio);
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.flv);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(feederKids).toHaveLength(2);
    expect(manager.status(29).running).toBe(false);
  });

  it('a mkfifo failure reports spawn_failed immediately without retrying', async () => {
    stubGateOn();
    vi.useFakeTimers();
    const { ffmpegKids, mkfifoKids } = useSpawns({ mkfifoFails: true });

    const result = await startPump({
      id: 30,
      source: FB_REPLAY,
        mode: 'staged',
      dest: DEST,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'spawn_failed',
      error: expect.stringContaining('could not create the source pipe'),
    });
    expect(mkfifoKids).toHaveLength(3);
    expect(ffmpegKids).toHaveLength(0);
    const fifos = latestFifoPaths();
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.video);
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.audio);
    expect(fsMocks.unlink).toHaveBeenCalledWith(fifos.flv);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mkfifoKids).toHaveLength(3);
    expect(manager.status(30).running).toBe(false);
  });
});

describe('media isolation quarantine', () => {
  it('refuses to start and never spawns when the verified runner is absent', async () => {
    stubGateOn(); // pass the runtime gate — the isolation check comes next
    isolationMock.mockReturnValue({
      available: false,
      reason: 'The media sandbox has not been initialized.',
    });

    const result = await getPumpManager().start({
      id: 9001,
      source: LIVE_HLS,
        mode: 'direct',
      dest: DEST,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'isolation_unavailable',
      error: 'The media sandbox has not been initialized.',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
