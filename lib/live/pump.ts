import { spawn, type ChildProcess } from 'node:child_process';

import { localRuntimeEnabled } from '@/lib/reels/media';

/**
 * Codecs of the probed source, as reported by ffprobe. Mirrors the
 * `VideoStreams` type in download-worker.ts — replicated here (not imported)
 * because download-worker.ts is a standalone worker script and must never
 * enter the server bundle.
 */
export type VideoStreams = {
  videoCodec: string | null;
  pixelFormat: string | null;
  audioCodec: string | null;
};

const EMPTY_STREAMS: VideoStreams = {
  videoCodec: null,
  pixelFormat: null,
  audioCodec: null,
};

/**
 * Facebook ingest plays H.264/yuv420p with AAC (or MP3, or no audio track).
 * The predicate mirrors `isSafariFriendly` in download-worker.ts — keep the
 * two in sync when codec support changes.
 */
export function decideTranscode(probe: VideoStreams): boolean {
  if (probe.videoCodec !== 'h264') return true;
  if (probe.pixelFormat !== 'yuv420p') return true;
  return !(
    probe.audioCodec === null ||
    probe.audioCodec === 'aac' ||
    probe.audioCodec === 'mp3'
  );
}

export type PumpArgsOptions = {
  source: string;
  dest: string;
  needsTranscode: boolean;
};

/**
 * Builds the ffmpeg command line for one pump attempt. `dest` is the fully
 * reassembled RTMPS ingest URL (see `assembleRtmpsUrl`) and is always the
 * last argv element, so every loggable rendering of the command can be
 * redacted with `redactStreamKey`.
 */
export function buildPumpArgs({
  source,
  dest,
  needsTranscode,
}: PumpArgsOptions): string[] {
  const args: string[] = [];
  if (source.includes('m3u8')) {
    // Live manifests are the only sources worth reconnecting: when a VOD
    // drops, the retry loop restarts the whole broadcast instead.
    args.push(
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_on_network_error',
      '1'
    );
  }
  args.push('-re', '-i', source);
  if (needsTranscode) {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k'
    );
  } else {
    args.push('-c', 'copy');
  }
  args.push('-f', 'flv', dest);
  return args;
}

/**
 * Reassembles the RTMPS ingest URL from the pieces the API stores:
 * `secure_stream_url` keeps the base without the key (see `splitStreamUrl` in
 * app/api/live/route.ts) and the key lives encrypted in `stream_key`. The
 * trailing slash is inserted when the base is missing one. Returns null when
 * either piece is missing so callers can guard before starting a pump.
 */
export function assembleRtmpsUrl(
  base: string | null,
  key: string | null
): string | null {
  if (!base || !key) return null;
  const withSlash = base.endsWith('/') ? base : `${base}/`;
  return `${withSlash}${key}`;
}

export const REDACTED_KEY = '***';

/**
 * Replaces the stream key with `***` in any string that could reach a log,
 * the database or an error response. The key is the last path segment of the
 * ingest URL, so callers pass the whole `dest`. Redaction happens when text
 * is captured — nothing unredacted is ever stored or logged.
 */
export function redactStreamKey(
  text: string,
  dest: string | null | undefined
): string {
  if (!text || !dest) return text;
  const key = dest.slice(dest.lastIndexOf('/') + 1);
  if (!key || key === REDACTED_KEY) return text;
  return text.split(key).join(REDACTED_KEY);
}

const FFMPEG_BIN = 'ffmpeg';
const FFPROBE_BIN = 'ffprobe';

/** Upper bound for the stderr tail kept per pump — recorded errors quote it. */
const STDERR_TAIL_CHARS = 8_000;

/** Transient failures are retried with this backoff (2s, 4s, 8s), then given up. */
export const RETRY_BACKOFF_MS = [2_000, 4_000, 8_000] as const;

/** SIGINT → SIGKILL grace period for a user stop. */
export const STOP_GRACE_MS = 5_000;

/**
 * stderr fragments that mean the pump can never succeed on this runtime:
 * the ingest endpoint refuses connections, or another publisher already
 * holds the stream key. No retry fixes either, so the pump gives up
 * immediately instead of hammering Facebook's ingest.
 */
const FATAL_STDERR_SIGNATURES = [
  'Connection refused',
  'Already publishing',
  'Failed to connect',
] as const;

export type PumpStartRequest = {
  id: number | string;
  source: string;
  dest: string;
};

export type PumpStartFailureReason =
  | 'gate_disabled'
  | 'already_running'
  | 'spawn_failed';

export type PumpStartResult =
  | { ok: true }
  | { ok: false; reason: PumpStartFailureReason; error: string };

export type PumpStatus = {
  running: boolean;
  startedAt: Date | null;
  error: string | null;
};

export type PumpStopResult = { ok: true; wasRunning: boolean };

type PumpParams = {
  source: string;
  dest: string;
  needsTranscode: boolean;
};

type PumpProc = {
  id: string;
  params: PumpParams;
  child: ChildProcess | null;
  startedAt: Date;
  attempts: number;
  retries: number;
  starting: boolean;
  stopping: boolean;
  running: boolean;
  fatalError: string | null;
  lastError: string | null;
  tail: string;
  retryTimer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
};

function parseProbeStreams(probeJson: string): VideoStreams {
  try {
    const parsed = JSON.parse(probeJson) as {
      streams?: { codec_type?: string; codec_name?: string; pix_fmt?: string }[];
    };
    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    return {
      videoCodec: video?.codec_name ?? null,
      pixelFormat: video?.pix_fmt ?? null,
      audioCodec: audio?.codec_name ?? null,
    };
  } catch {
    return { ...EMPTY_STREAMS };
  }
}

export class PumpManager {
  private procs = new Map<string, PumpProc>();

  async start({
    id,
    source,
    dest,
  }: PumpStartRequest): Promise<PumpStartResult> {
    const key = String(id);
    if (!localRuntimeEnabled()) {
      return {
        ok: false,
        reason: 'gate_disabled',
        error:
          'Local video processing is disabled on this runtime, so the pump cannot spawn ffmpeg.',
      };
    }
    const existing = this.procs.get(key);
    if (
      existing &&
      (existing.running || existing.retryTimer !== null || existing.starting)
    ) {
      return {
        ok: false,
        reason: 'already_running',
        error: `Stream ${key} already has a live pump process.`,
      };
    }

    // Reserve the slot before the async probe so a second start racing the
    // first cannot spawn a duplicate pump.
    const proc: PumpProc = {
      id: key,
      params: { source, dest, needsTranscode: true },
      child: null,
      startedAt: new Date(),
      attempts: 0,
      retries: 0,
      starting: true,
      stopping: false,
      running: false,
      fatalError: null,
      lastError: null,
      tail: '',
      retryTimer: null,
      killTimer: null,
    };
    this.procs.set(key, proc);

    // An unprobeable source defaults to transcode: Facebook rejects unknown
    // codecs, and a needless re-encode is cheaper than a dead broadcast.
    const streams = await this.probeSource(source);
    proc.params.needsTranscode = decideTranscode(streams);
    proc.starting = false;
    if (proc.stopping) return { ok: true };

    try {
      this.spawnAttempt(proc);
    } catch (error) {
      this.procs.delete(key);
      return {
        ok: false,
        reason: 'spawn_failed',
        error: redactStreamKey(
          error instanceof Error ? error.message : String(error),
          dest
        ),
      };
    }
    return { ok: true };
  }

  stop(id: number | string): PumpStopResult {
    const proc = this.procs.get(String(id));
    if (!proc || (!proc.running && proc.retryTimer === null)) {
      return { ok: true, wasRunning: false };
    }
    proc.stopping = true;
    if (proc.retryTimer) {
      clearTimeout(proc.retryTimer);
      proc.retryTimer = null;
    }
    const child = proc.child;
    if (child) {
      child.kill('SIGINT');
      proc.killTimer = setTimeout(() => {
        proc.killTimer = null;
        if (proc.child === child) child.kill('SIGKILL');
      }, STOP_GRACE_MS);
      proc.killTimer.unref?.();
    }
    return { ok: true, wasRunning: true };
  }

  /**
   * Unknown ids report "not running": the pump API layer maps a DB row marked
   * running with no live manager process to `interrupted`.
   */
  status(id: number | string): PumpStatus {
    const proc = this.procs.get(String(id));
    if (!proc) return { running: false, startedAt: null, error: null };
    return {
      running: proc.running,
      startedAt: proc.startedAt,
      error: proc.lastError,
    };
  }

  /** Test hook: drops all tracked processes and timers, never touches real children. */
  resetForTests(): void {
    for (const proc of this.procs.values()) {
      if (proc.retryTimer) clearTimeout(proc.retryTimer);
      if (proc.killTimer) clearTimeout(proc.killTimer);
    }
    this.procs.clear();
  }

  private spawnAttempt(proc: PumpProc): void {
    proc.attempts += 1;
    if (proc.attempts === 1) {
      this.log(proc, 'started', { transcode: proc.params.needsTranscode });
    }
    const child = spawn(FFMPEG_BIN, buildPumpArgs(proc.params), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.child = child;
    proc.running = true;
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      proc.child = null;
      proc.running = false;
      if (proc.killTimer) {
        clearTimeout(proc.killTimer);
        proc.killTimer = null;
      }
      this.settleAttempt(proc, code);
    };

    // Nothing reads ffmpeg's stdout; a data listener puts the pipe in
    // flowing mode so it can never backpressure the encoder.
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = redactStreamKey(chunk.toString(), proc.params.dest);
      proc.tail = (proc.tail + text).slice(-STDERR_TAIL_CHARS);
      const fatal = FATAL_STDERR_SIGNATURES.find((signature) =>
        text.toLowerCase().includes(signature.toLowerCase())
      );
      if (fatal && !proc.stopping) {
        proc.fatalError = `ffmpeg reported a fatal error ("${fatal}") — giving up without retry.`;
        this.log(proc, 'fatal', { error: proc.fatalError });
        child.kill('SIGKILL');
      }
    });
    child.once('error', (error: Error) => {
      // Spawn failures emit 'error' (pid undefined) and then 'close'; the
      // close handler owns the terminal decision. A mid-run error on a live
      // process is only recorded — its own close follows.
      const text = redactStreamKey(error.message, proc.params.dest);
      proc.tail = (proc.tail + text).slice(-STDERR_TAIL_CHARS);
      if (!child.pid) {
        proc.lastError = `could not start ffmpeg: ${text}`;
      }
    });
    child.once('close', (code: number | null) => finish(code));
  }

  private settleAttempt(proc: PumpProc, code: number | null): void {
    if (proc.stopping) {
      this.log(proc, 'stopped', { code, reason: 'user_stop' });
      return;
    }
    if (proc.fatalError) {
      proc.lastError = proc.fatalError;
      this.log(proc, 'failed', { error: proc.lastError });
      return;
    }
    if (code === 0) {
      // The source ended cleanly — e.g. a VOD broadcast through once.
      this.log(proc, 'stopped', { code });
      return;
    }
    if (proc.retries >= RETRY_BACKOFF_MS.length) {
      proc.lastError = redactStreamKey(
        `ffmpeg exited with code ${code} after ${RETRY_BACKOFF_MS.length} retries. Last stderr: ${
          proc.tail.trim().slice(-400) || 'none'
        }`,
        proc.params.dest
      );
      this.log(proc, 'failed', {
        error: proc.lastError,
        retries: proc.retries,
      });
      return;
    }
    const delay = RETRY_BACKOFF_MS[proc.retries];
    proc.retries += 1;
    proc.retryTimer = setTimeout(() => {
      proc.retryTimer = null;
      this.spawnAttempt(proc);
    }, delay);
    proc.retryTimer.unref?.();
    this.log(proc, 'retry', { delayMs: delay, retry: proc.retries });
  }

  private probeSource(source: string, timeoutMs = 15_000): Promise<VideoStreams> {
    return new Promise((resolve) => {
      const child = spawn(
        FFPROBE_BIN,
        ['-v', 'error', '-show_streams', '-of', 'json', source],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      timer.unref?.();
      child.once('error', () => {
        clearTimeout(timer);
        resolve({ ...EMPTY_STREAMS });
      });
      child.once('close', (code: number | null) => {
        clearTimeout(timer);
        resolve(code === 0 ? parseProbeStreams(output) : { ...EMPTY_STREAMS });
      });
    });
  }

  private log(
    proc: PumpProc,
    event: string,
    extra: Record<string, unknown>
  ): void {
    // Every string here is redacted at capture time — never log raw stderr.
    console.log(
      JSON.stringify({ area: 'live-pump', event, streamId: proc.id, ...extra })
    );
  }
}

type PumpGlobal = typeof globalThis & {
  __phLivePumpManager?: PumpManager;
};

const holder = globalThis as PumpGlobal;

/**
 * One PumpManager per server process, cached on globalThis so Next dev hot
 * reloads reuse the same process map (and its live children) instead of
 * orphaning them. Children still die when the server process itself exits —
 * the pump API layer then reports those streams as `interrupted`.
 */
export function getPumpManager(): PumpManager {
  if (!holder.__phLivePumpManager) {
    holder.__phLivePumpManager = new PumpManager();
  }
  return holder.__phLivePumpManager;
}
