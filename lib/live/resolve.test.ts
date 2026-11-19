import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const { spawnMock, isolationMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  isolationMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('./media-egress', () => ({
  guardedSpawn: (...args: unknown[]) => spawnMock(...args),
  assertMediaIsolationAvailable: isolationMock,
  MediaIsolationError: class MediaIsolationError extends Error {
    readonly code = 'media_isolation_unavailable';
    constructor(message = 'isolation unavailable') {
      super(message);
      this.name = 'MediaIsolationError';
    }
  },
  MEDIA_ISOLATION_ERROR_CODE: 'media_isolation_unavailable',
  MEDIA_ISOLATION_UNAVAILABLE_MESSAGE: 'isolation unavailable',
}));

import { ResolveError, resolveVideoUrl } from './resolve';

const LIVE_URL = 'https://www.youtube.com/watch?v=live1';
const VOD_URL = 'https://www.youtube.com/watch?v=zoo1';

// Fixtures mimic `yt-dlp -J` output, trimmed to the fields the resolver reads.
const LIVE_FIXTURE = JSON.stringify({
  id: 'live1',
  title: 'City Council — Live',
  is_live: true,
  extractor: 'youtube',
  extractor_key: 'Youtube',
  formats: [
    {
      format_id: 'dash',
      url: 'https://manifest.example/live.mpd',
      protocol: 'dash',
      vcodec: 'h264',
      acodec: 'none',
    },
    {
      format_id: 'hls',
      url: 'https://manifest.example/live.m3u8',
      protocol: 'm3u8_native',
      vcodec: 'h264',
      acodec: 'aac',
    },
  ],
});

const VOD_FIXTURE = JSON.stringify({
  id: 'zoo1',
  title: 'Me at the zoo',
  is_live: false,
  // No extractor_key: the resolver falls back to `extractor`.
  extractor: 'youtube',
  formats: [
    {
      format_id: 'hls',
      url: 'https://manifest.example/vod.m3u8',
      protocol: 'm3u8_native',
      vcodec: 'h264',
      acodec: 'aac',
    },
    {
      format_id: '18',
      url: 'https://cdn.example/videoplayback.webm',
      protocol: 'https',
      vcodec: 'vp8',
      acodec: 'vorbis',
      ext: 'webm',
    },
    {
      format_id: '22',
      url: 'https://cdn.example/videoplayback.mp4',
      protocol: 'https',
      vcodec: 'h264',
      acodec: 'aac',
      ext: 'mp4',
    },
  ],
});

// Facebook replay VODs return ONLY http_dash_segments fragment formats — no
// progressive file, no HLS manifest, no manifest_url, no top-level url.
// Nothing can be played directly, but the pump can pipe both feeds, so the
// resolver must classify this as `staged`, not as a failure.
const DASH_ONLY_FIXTURE = JSON.stringify({
  id: 'fb-replay',
  title: 'Press briefing — replay',
  is_live: false,
  extractor: 'facebook',
  extractor_key: 'Facebook',
  formats: [
    {
      format_id: 'dash-video-3928',
      url: 'https://scontent.example/405556_video_dashinit.mp4',
      protocol: 'http_dash_segments',
      vcodec: 'avc1.640029',
      acodec: 'none',
      ext: 'mp4',
    },
    {
      format_id: 'dash-audio-141',
      url: 'https://scontent.example/205299_audio_dashinit.mp4',
      protocol: 'http_dash_segments',
      vcodec: 'none',
      acodec: 'mp4a.40.5',
      ext: 'm4a',
    },
  ],
});

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: Mock;
};

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // SIGKILL closes the process; the resolver's timedOut flag maps that close
  // to the `timeout` code.
  child.kill = vi.fn(() => child.emit('close', null, 'SIGKILL'));
  return child;
}

function succeedWith(child: FakeChild, stdout: string, code = 0) {
  child.stdout.emit('data', Buffer.from(stdout));
  child.emit('close', code, null);
}

function failWith(child: FakeChild, stderr: string, code = 1) {
  child.stderr.emit('data', Buffer.from(stderr));
  child.emit('close', code, null);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

beforeEach(() => {
  spawnMock.mockReset();
  isolationMock.mockReset();
  isolationMock.mockImplementation(() => {}); // verified runner present
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveVideoUrl', () => {
  it.each(['ftp://x', 'javascript:alert(1)', '', '   '])(
    'rejects non-http URL %j with ResolveError invalid_url and never spawns yt-dlp',
    async (input) => {
      const error = (await rejectionOf(resolveVideoUrl(input))) as ResolveError;
      expect(error).toBeInstanceOf(ResolveError);
      expect(error.code).toBe('invalid_url');
      expect(spawnMock).not.toHaveBeenCalled();
    }
  );

  it('passes the URL as a single argv element to spawn with shell disabled', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = resolveVideoUrl(VOD_URL);
    succeedWith(child, VOD_FIXTURE);
    await pending;

    expect(spawnMock).toHaveBeenCalledOnce();
    const [command, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(options.shell).toBe(false);
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(
      expect.arrayContaining(['-J', '--no-playlist', '--js-runtimes', 'node'])
    );
    expect(args.at(-1)).toBe(VOD_URL);
    expect(args.filter((arg) => arg === VOD_URL)).toHaveLength(1);
    expect(command).not.toContain(VOD_URL);
  });

  it('parses a live yt-dlp JSON payload into { title, isLive: true, playableUrl: manifest, extractor }', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = resolveVideoUrl(LIVE_URL);
    succeedWith(child, LIVE_FIXTURE);

    await expect(pending).resolves.toEqual({
      title: 'City Council — Live',
      isLive: true,
      playableUrl: 'https://manifest.example/live.m3u8',
      mode: 'direct',
      extractor: 'Youtube',
    });
  });

  it('parses a VOD yt-dlp JSON payload into { isLive: false, playableUrl: progressive mp4 URL }', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = resolveVideoUrl(VOD_URL);
    succeedWith(child, VOD_FIXTURE);

    // The progressive mp4 beats the webm progressive file and the HLS manifest;
    // extractor falls back from the missing extractor_key to `extractor`.
    await expect(pending).resolves.toEqual({
      title: 'Me at the zoo',
      isLive: false,
      playableUrl: 'https://cdn.example/videoplayback.mp4',
      mode: 'direct',
      extractor: 'youtube',
    });
  });

  it('classifies a DASH-segments-only payload (Facebook replay shape) as staged with playableUrl null and no throw', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = resolveVideoUrl(VOD_URL);
    succeedWith(child, DASH_ONLY_FIXTURE);

    await expect(pending).resolves.toEqual({
      title: 'Press briefing — replay',
      isLive: false,
      playableUrl: null,
      mode: 'staged',
      extractor: 'Facebook',
    });
  });

  it('maps yt-dlp stderr "Video unavailable" to ResolveError unavailable', async () => {
    const stderr = 'ERROR: [youtube] live1: Video unavailable. This video is private';
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = resolveVideoUrl(LIVE_URL);
    failWith(child, stderr);

    const error = (await rejectionOf(pending)) as ResolveError;
    expect(error).toBeInstanceOf(ResolveError);
    expect(error.code).toBe('unavailable');
    expect(error.message).not.toContain(stderr);
  });

  it('maps yt-dlp stderr "Sign in to confirm you\'re not a bot" to ResolveError auth_required', async () => {
    const stderr =
      "ERROR: [youtube] live1: Sign in to confirm you're not a bot. This helps protect our community.";
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = resolveVideoUrl(LIVE_URL);
    failWith(child, stderr);

    const error = (await rejectionOf(pending)) as ResolveError;
    expect(error).toBeInstanceOf(ResolveError);
    expect(error.code).toBe('auth_required');
    expect(error.message).not.toContain(stderr);
  });

  it('maps yt-dlp stderr "Unsupported URL" to ResolveError unsupported', async () => {
    const stderr = 'ERROR: Unsupported URL: https://example.invalid/page';
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = resolveVideoUrl(VOD_URL);
    failWith(child, stderr);

    const error = (await rejectionOf(pending)) as ResolveError;
    expect(error).toBeInstanceOf(ResolveError);
    expect(error.code).toBe('unsupported');
  });

  it('maps a non-zero exit with unrecognized stderr to ResolveError failed', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = resolveVideoUrl(VOD_URL);
    failWith(child, 'ERROR: something exploded internally');

    const error = (await rejectionOf(pending)) as ResolveError;
    expect(error).toBeInstanceOf(ResolveError);
    expect(error.code).toBe('failed');
    expect(error.message).not.toContain('exploded');
  });

  it('maps a hung yt-dlp process to ResolveError timeout and kills the child', async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      spawnMock.mockReturnValue(child);
      const pending = resolveVideoUrl(LIVE_URL);
      const rejection = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(20_000);
      await rejection;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(spawnMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('parses a yt-dlp payload with no usable stream URL as a staged success, not a failure', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = resolveVideoUrl(VOD_URL);
    succeedWith(child, JSON.stringify({ id: 'x', title: 'Empty', is_live: false }));

    await expect(pending).resolves.toEqual({
      title: 'Empty',
      isLive: false,
      playableUrl: null,
      mode: 'staged',
      extractor: 'unknown',
    });
  });

  describe('binary lookup', () => {
    it('uses YTDLP_PATH as the spawned command when set', async () => {
      vi.stubEnv('YTDLP_PATH', '/custom/yt-dlp');
      const child = makeChild();
      spawnMock.mockReturnValue(child);
      const pending = resolveVideoUrl(VOD_URL);
      succeedWith(child, VOD_FIXTURE);
      await pending;

      expect(spawnMock).toHaveBeenCalledOnce();
      expect(spawnMock.mock.calls[0][0]).toBe('/custom/yt-dlp');
    });

    it('falls back to yt-dlp on PATH when YTDLP_PATH is unset', async () => {
      vi.stubEnv('YTDLP_PATH', '');
      const child = makeChild();
      spawnMock.mockReturnValue(child);
      const pending = resolveVideoUrl(VOD_URL);
      succeedWith(child, VOD_FIXTURE);
      await pending;

      expect(spawnMock).toHaveBeenCalledOnce();
      expect(spawnMock.mock.calls[0][0]).toBe('yt-dlp');
    });

    it('falls back to the venv python -m yt_dlp when yt-dlp cannot be spawned', async () => {
      vi.stubEnv('YTDLP_PYTHON', '/venv/python');
      const missing = makeChild();
      const working = makeChild();
      spawnMock.mockReturnValueOnce(missing).mockReturnValueOnce(working);
      const pending = resolveVideoUrl(VOD_URL);
      // The first candidate fails to start; the loop advances on the next tick.
      missing.emit('error', Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }));
      await Promise.resolve();
      succeedWith(working, VOD_FIXTURE);
      await pending;

      expect(spawnMock).toHaveBeenCalledTimes(2);
      const [command, args] = spawnMock.mock.calls[1] as [string, string[]];
      expect(command).toBe('/venv/python');
      expect(args.slice(0, 6)).toEqual([
        '-m',
        'yt_dlp',
        '-J',
        '--no-playlist',
        '--js-runtimes',
        'node',
      ]);
      expect(args.at(-1)).toBe(VOD_URL);
    });
  });
});

describe('media isolation quarantine', () => {
  it('refuses to resolve and never spawns yt-dlp when the verified runner is absent', async () => {
    isolationMock.mockImplementation(() => {
      throw new Error('isolation unavailable'); // not MediaIsolationError:
      // the resolver rethrows unknown errors untouched.
    });

    const error = (await rejectionOf(resolveVideoUrl(VOD_URL))) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('isolation unavailable');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
