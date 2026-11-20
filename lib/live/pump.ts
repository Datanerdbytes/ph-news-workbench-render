import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  open as fsOpen,
  type FileHandle,
  unlink as fsUnlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { localRuntimeEnabled } from '@/lib/reels/media';
import { mediaSandboxAvailability } from './media-sandbox';
import { guardedSpawn, signalProcessTree } from './media-egress';
import { pythonExecutable } from '@/lib/live/resolve';

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
  /** Local flv fifo the sandboxed side writes; the publisher reads it. */
  outFifo: string;
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
  outFifo,
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
  // The sandboxed side writes to the local fifo; the UNSANDBOXED publisher
  // (see buildPublisherArgs) owns the RTMPS connection — its destination is
  // the Graph-provided ingest URL, never user input.
  args.push('-y', '-f', 'flv', outFifo);
  return args;
}

// ---------------------------------------------------------------------------
// Staged mode — DASH-only sources (Facebook replay VODs) expose only
// http_dash_segments fragment formats: no playable URL exists for ffmpeg to
// open directly. Two yt-dlp feeder processes instead pipe video-only and
// audio-only DASH through named FIFOs, and ffmpeg copies them into the
// broadcast (proven by a local PoC against a real replay URL).
// ---------------------------------------------------------------------------

export type StagedPumpArgsOptions = {
  videoFifo: string;
  audioFifo: string;
  outFifo: string;
};

/**
 * Builds the ffmpeg command line for a staged attempt. The fifos are opened
 * as plain inputs — ffmpeg blocks on their read-ends until the feeders open
 * the write-ends (see `spawnStagedAttempt` for the ordering contract). `-re`
 * paces both inputs at native rate, so the pipe buffer fills and backpressure
 * throttles the feeders: the download cannot outrun the broadcast. Video is
 * copied (Facebook DASH is avc1/H.264; vp9-only video is a documented v1
 * limitation); audio is always transcoded to AAC, which handles opus/mp3 DASH
 * sources. `dest` stays the last argv element for `redactStreamKey`.
 */
export function buildStagedPumpArgs({
  videoFifo,
  audioFifo,
  outFifo,
}: StagedPumpArgsOptions): string[] {
  return [
    '-re',
    '-i',
    videoFifo,
    '-i',
    audioFifo,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-y',
    '-f',
    'flv',
    outFifo,
  ];
}

export type FeederKind = 'video' | 'audio';

/**
 * Builds the UNSANDBOXED publisher's command line: it reads the flv fifo the
 * sandboxed side writes and copies the bytes to Facebook's RTMPS ingest. The
 * destination comes from Facebook's Graph response (never user input), and
 * the pump route additionally pins it to the Facebook ingest hosts before
 * the pump starts.
 */
export function buildPublisherArgs({
  flvFifo,
  dest,
}: {
  flvFifo: string;
  dest: string;
}): string[] {
  return ['-f', 'flv', '-i', flvFifo, '-c', 'copy', '-f', 'flv', dest];
}

/**
 * Defense in depth for the unsandboxed publisher: the ingest URL is
 * Facebook's own Graph response, so its host must be a Facebook endpoint.
 * Anything else refuses before the publisher can dial it.
 */
export function isFacebookIngestUrl(dest: string): boolean {
  try {
    const parsed = new URL(dest);
    return (
      (parsed.protocol === 'rtmps:' || parsed.protocol === 'rtmp:') &&
      (parsed.hostname === 'live-api-s.facebook.com' ||
        parsed.hostname.endsWith('.facebook.com'))
    );
  } catch {
    return false;
  }
}

/**
 * yt-dlp args for one staged feeder: select the best video-only (H.264 at
 * ≤1080p preferred, since Facebook ingest wants it) or audio-only format and
 * write the media bytes to stdout (`-o -`). The URL is always the last argv
 * element and stays a single element — never shell-interpolated.
 */
export function buildFeederArgs(url: string, kind: FeederKind): string[] {
  const format =
    kind === 'video'
      ? 'bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]/bv*'
      : 'ba/b';
  return [
    '-f',
    format,
    '--no-playlist',
    // Mirrors download-worker.ts buildYtdlpArgs — yt-dlp needs a JS runtime
    // for sites whose challenge code runs in JS (required for YouTube).
    '--js-runtimes',
    'node',
    '--no-part',
    '--newline',
    '-o',
    '-',
    url,
  ];
}

const YT_DLP_BIN = 'yt-dlp';

/**
 * Where to find yt-dlp for the feeders — the same lookup order as the
 * resolver (YTDLP_PATH → yt-dlp on PATH → the dev venv interpreter).
 */
function feederCandidates(
  url: string,
  kind: FeederKind
): { command: string; args: string[] }[] {
  const args = buildFeederArgs(url, kind);
  const candidates: { command: string; args: string[] }[] = [];
  const envPath = process.env.YTDLP_PATH?.trim();
  if (envPath) candidates.push({ command: envPath, args });
  candidates.push({ command: YT_DLP_BIN, args });
  candidates.push({
    command: pythonExecutable(),
    args: ['-m', 'yt_dlp', ...args],
  });
  return candidates;
}

/**
 * stderr lines from a feeder that mean retrying can never succeed: the
 * source demands a sign-in/bot check the server cannot complete, or the
 * video is gone. Mirrors the resolver's failure classification
 * (`classifyFailure` in lib/live/resolve.ts). Only yt-dlp ERROR lines are
 * matched — a WARNING must not fail the broadcast.
 */
const FEEDER_FATAL_STDERR_SIGNATURES = [
  'sign in',
  'log in',
  'not a bot',
  'age-restrict',
  'confirm your age',
  'members-only',
  'private video',
  'video unavailable',
  'no longer available',
] as const;

const MKFIFO_BIN = 'mkfifo';

/**
 * Per-phase deadline for one fifo write-end open (see `openFifoWriteEnd`).
 * Generous on purpose: ffmpeg's avformat probe of the video pipe blocks
 * until the feeder delivers enough bytes, and CDN variance makes yt-dlp's
 * first burst unpredictable (the PoC saw ~1.4KB/s bursts ramping up to MB/s
 * on fbcdn). A timeout here is transient anyway — it retries with a fresh
 * attempt instead of failing the start.
 */
export const FIFO_OPEN_TIMEOUT_MS = 30_000;

/**
 * Thrown when a fifo write-end open outlasts its per-phase deadline — e.g.
 * a slow CDN starved ffmpeg's probe past the ceiling. Transient by nature:
 * the attempt settles into the normal retry path (fresh fifos, download
 * restarts from zero) instead of failing the start outright.
 */
class OpenTimeoutError extends Error {}

type FifoPair = { video: string; audio: string; flv: string };

/** Unique fifo pair under the OS temp dir — a fresh pair per attempt. */
function stagedFifoPaths(): FifoPair {
  const token = randomUUID();
  return {
    video: path.join(os.tmpdir(), `live-pump-${token}-video`),
    audio: path.join(os.tmpdir(), `live-pump-${token}-audio`),
    flv: path.join(os.tmpdir(), `live-pump-${token}-flv`),
  };
}

/**
 * Creates one fifo with owner-only permissions (`-m 0600` keeps other users
 * from reading the stream). `mkfifo` is spawned directly — the path is an
 * argv element, never shell-interpolated.
 */
async function makeFifo(fifoPath: string): Promise<void> {
  const child = await guardedSpawn(MKFIFO_BIN, ['-m', '0600', fifoPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error: Error) => {
      reject(new Error(`could not create the source pipe: ${error.message}`));
    });
    child.once('close', (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `could not create the source pipe: ${
            stderr.trim() || `mkfifo exited with code ${code}`
          }`
        )
      );
    });
  });
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
  /** Local flv fifo the sandboxed side writes; the publisher reads it. */
  outFifo: string;
  dest: string;
  /**
   * How the pump consumes `source`: 'direct' opens the playable URL with
   * ffmpeg (ffprobe decides copy vs transcode); 'staged' pipes two yt-dlp
   * feeder processes through fifos for DASH-only sources. Defaults to
   * 'direct'.
   */
  mode?: 'direct' | 'staged';
};

export type PumpStartFailureReason =
  | 'gate_disabled'
  | 'isolation_unavailable'
  | 'already_running'
  | 'spawn_failed';

export type PumpStartResult =
  | { ok: true }
  | { ok: false; reason: PumpStartFailureReason; error: string };

export type PumpStatus = {
  running: boolean;
  startedAt: Date | null;
  error: string | null;
  /**
   * True while a retry backoff timer is pending: the current attempt is dead
   * but the pump is not terminal — the next spawn is already scheduled.
   * External reconcilers must treat this as still running, never as an exit.
   */
  retrying: boolean;
};

export type PumpStopResult = { ok: true; wasRunning: boolean };

type PumpParams = {
  source: string;
  /** Local flv fifo written by the sandboxed side. */
  outFifo: string;
  /** The RTMPS destination, used only for key redaction in logs. */
  dest: string;
  needsTranscode: boolean;
  mode: 'direct' | 'staged';
};

type PumpProc = {
  id: string;
  params: PumpParams;
  child: ChildProcess | null;
  /** The attempt's yt-dlp feeders (staged mode only; empty for direct). */
  feeders: ChildProcess[];
  /** This attempt's fifo trio, from creation until unlink (staged only). */
  fifos: FifoPair | null;
  /** The flv output fifo (every mode; pairs with the publisher's input). */
  flvFifo: string | null;
  /** The unsandboxed RTMPS publisher — the only child outside the sandbox. */
  publisher: ChildProcess | null;
  /** Write-end opens still waiting for a reader — unblocked on teardown. */
  pendingOpens: Promise<FileHandle>[];
  startedAt: Date;
  attempts: number;
  retries: number;
  starting: boolean;
  stopping: boolean;
  running: boolean;
  /** First death (ffmpeg, feeder, setup failure) settles the attempt. */
  attemptSettled: boolean;
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
    outFifo,
    dest,
    mode = 'direct',
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
    // Fail closed before ANY native child can be launched (probe, ffmpeg,
    // feeders, fifo helpers): without verified socket-level isolation the
    // tools' nested requests are not constrained by URL checks alone.
    const isolation = mediaSandboxAvailability();
    if (!isolation.available) {
      return {
        ok: false,
        reason: 'isolation_unavailable',
        error: isolation.reason,
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

    // Reserve the slot before the async probe/setup so a second start racing
    // the first cannot spawn a duplicate pump.
    const proc: PumpProc = {
      id: key,
      params: {
        source,
        outFifo,
        dest,
        needsTranscode: true,
        mode: mode === 'staged' ? 'staged' : 'direct',
      },
      child: null,
      feeders: [],
      fifos: null,
      flvFifo: null,
      publisher: null,
      pendingOpens: [],
      startedAt: new Date(),
      attempts: 0,
      retries: 0,
      starting: true,
      stopping: false,
      running: false,
      attemptSettled: false,
      fatalError: null,
      lastError: null,
      tail: '',
      retryTimer: null,
      killTimer: null,
    };
    this.procs.set(key, proc);

    if (proc.params.mode === 'staged') {
      // Pipes are unprobeable — no ffprobe; the args are fixed (video copied,
      // audio transcoded). A setup failure that no child death settled
      // (missing mkfifo, yt-dlp unavailable) cannot self-heal, so the first
      // attempt reports spawn_failed instead of churning through retries.
      try {
        await this.spawnStagedAttempt(proc);
      } catch (error) {
        if (proc.attemptSettled || proc.stopping) {
          // ffmpeg died during setup — its close handler already settled the
          // attempt into the normal retry state machine (or a stop won).
          return { ok: true };
        }
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

    // An unprobeable source defaults to transcode: Facebook rejects unknown
    // codecs, and a needless re-encode is cheaper than a dead broadcast.
    const streams = await this.probeSource(source);
    proc.params.needsTranscode = decideTranscode(streams);
    proc.starting = false;
    if (proc.stopping) return { ok: true };

    try {
      await this.spawnAttempt(proc);
    } catch (error) {
      this.teardownStagedAttempt(proc);
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
    if (!proc) return { ok: true, wasRunning: false };
    // Mark stopping even while a start/setup is still in flight: the staged
    // setup checks it between steps and aborts instead of spawning orphaned
    // children (this also closes the direct path's probe-window race).
    proc.stopping = true;
    if (proc.retryTimer) {
      clearTimeout(proc.retryTimer);
      proc.retryTimer = null;
    }
    if (!proc.running && !proc.starting && proc.retryTimer === null) {
      return { ok: true, wasRunning: false };
    }
    const child = proc.child;
    const feeders = [...proc.feeders];
    const publisher = proc.publisher;
    // Feeders first, then ffmpeg: yt-dlp handles SIGINT gracefully and the
    // fifos lose their writers, letting ffmpeg unwind; the publisher gets the
    // same signal so the flv leg shuts down with the rest of the chain.
    for (const feeder of feeders) signalProcessTree(feeder, 'SIGINT');
    if (child) signalProcessTree(child, 'SIGINT');
    if (publisher) signalProcessTree(publisher, 'SIGINT');
    if (child || feeders.length > 0 || publisher) {
      proc.killTimer = setTimeout(() => {
        proc.killTimer = null;
        for (const feeder of proc.feeders) signalProcessTree(feeder, 'SIGKILL');
        if (child && proc.child === child) signalProcessTree(child, 'SIGKILL');
        if (publisher && proc.publisher === publisher) {
          signalProcessTree(publisher, 'SIGKILL');
        }
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
    if (!proc) {
      return { running: false, startedAt: null, error: null, retrying: false };
    }
    return {
      running: proc.running,
      startedAt: proc.startedAt,
      error: proc.lastError,
      retrying: proc.retryTimer !== null,
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

  // ------------------------------------------------------------------ direct

  private async spawnAttempt(proc: PumpProc): Promise<void> {
    proc.attempts += 1;
    proc.attemptSettled = false;
    if (proc.attempts === 1) {
      this.log(proc, 'started', { transcode: proc.params.needsTranscode });
    }

    proc.starting = true;
    await makeFifo(proc.params.outFifo);
    proc.flvFifo = proc.params.outFifo;
    if (proc.stopping) {
      this.unlinkFlvFifo(proc);
      proc.starting = false;
      return;
    }

    // The publisher is the unsandboxed tail of the chain: it owns the only
    // RTMPS connection, whose destination is Facebook's Graph response. It
    // spawns first so its pending read-end pairs with ffmpeg's output open.
    proc.publisher = spawn(
      FFMPEG_BIN,
      buildPublisherArgs({
        flvFifo: proc.params.outFifo,
        dest: proc.params.dest,
      }),
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true }
    );
    this.attachPublisherHandlers(proc, proc.publisher);

    const child = await guardedSpawn(
      FFMPEG_BIN,
      buildPumpArgs({
        source: proc.params.source,
        outFifo: proc.params.outFifo,
        needsTranscode: proc.params.needsTranscode,
      }),
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    proc.child = child;
    this.attachFfmpegHandlers(proc, child);
    if (proc.stopping || proc.attemptSettled) {
      this.teardownStagedAttempt(proc);
      return;
    }
    proc.starting = false;
    proc.running = true;
  }

  /**
   * Wires ffmpeg's stdout drain, the redacting stderr watchdog and the
   * once-per-attempt close decision. Shared by direct and staged attempts —
   * the staged cleanup (feeders, fifos) runs through `teardownStagedAttempt`,
   * which is a no-op for direct pumps (no feeders, no fifos).
   */
  private attachFfmpegHandlers(proc: PumpProc, child: ChildProcess): void {
    child.once('close', (code: number | null) => {
      // First death of the attempt settles it; every later close is a no-op.
      if (!this.markAttemptSettled(proc)) return;
      proc.child = null;
      proc.running = false;
      if (proc.killTimer) {
        clearTimeout(proc.killTimer);
        proc.killTimer = null;
      }
      this.teardownStagedAttempt(proc);
      this.settleAttempt(proc, code);
    });

    // Nothing reads ffmpeg's stdout; a data listener puts the pipe in
    // flowing mode so it can never backpressure the encoder.
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = redactStreamKey(chunk.toString(), proc.params.dest);
      proc.tail = (proc.tail + text).slice(-STDERR_TAIL_CHARS);
      if (proc.attemptSettled || proc.stopping) return;
      const fatal = FATAL_STDERR_SIGNATURES.find((signature) =>
        text.toLowerCase().includes(signature.toLowerCase())
      );
      if (fatal) {
        proc.fatalError = `ffmpeg reported a fatal error ("${fatal}") — giving up without retry.`;
        this.log(proc, 'fatal', { error: proc.fatalError });
        this.killAttemptProcs(proc);
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
  }

  /**
   * Publisher lifecycle: stderr joins the redacted tail; a non-zero exit
   * settles the attempt through the same state machine as a crashed ffmpeg
   * (the sandboxed source side gets EPIPE on its output and follows). An
   * exit 0 would mean Facebook closed cleanly — the source side EOFs next
   * and settles the attempt as a clean stop.
   */
  private attachPublisherHandlers(proc: PumpProc, publisher: ChildProcess): void {
    publisher.stdout?.on('data', () => {});
    publisher.stderr?.on('data', (chunk: Buffer) => {
      const text = redactStreamKey(chunk.toString(), proc.params.dest);
      proc.tail = (proc.tail + text).slice(-STDERR_TAIL_CHARS);
    });
    publisher.once('close', (code: number | null) => {
      if (proc.attemptSettled || proc.stopping) return;
      if (code === 0) return;
      this.failAttempt(
        proc,
        `the RTMPS publisher exited with code ${code}`,
        code ?? 1
      );
    });
    publisher.once('error', (error: Error) => {
      proc.lastError = `could not start the RTMPS publisher: ${redactStreamKey(error.message, proc.params.dest)}`;
      this.log(proc, 'publisher_error', { error: proc.lastError });
    });
  }

  // ------------------------------------------------------------------ staged

  /**
   * One staged attempt: fresh fifo pair → ffmpeg → video pipe → audio pipe.
   *
   * ORDERING — do not reorder into a deadlock (an earlier version that
   * opened both write-ends up front timed out on every real run). ffmpeg
   * opens and PROBES its inputs sequentially: open(v.fifo) pairs with the
   * pending writer, then avformat probing BLOCKS READING BYTES from v.fifo
   * before ffmpeg proceeds to open a.fifo at all. So each write-end must be
   * opened and its feeder spawned BEFORE the next fifo is touched, letting
   * bytes flow as soon as each pair forms (mirrors the shell PoC, where the
   * feeder processes already held their write-ends before ffmpeg started):
   *
   * 1. `mkfifo` creates the pair (nothing is open yet).
   * 2. ffmpeg spawns first; its open(v.fifo, O_RDONLY) pends.
   * 3. the parent opens v.fifo O_WRONLY — pairs immediately.
   * 4. the video feeder spawns at once and writes fragment bytes, feeding
   *    ffmpeg's probe.
   * 5. only then is a.fifo opened — it pairs when ffmpeg reaches input 1
   *    (right after the video probe completes) — and the audio feeder
   *    spawns.
   * Opening both write-ends first deadlocks: ffmpeg never opens a.fifo's
   * read-end until video probe bytes arrive, and no feeder exists yet to
   * write them.
   */
  private async spawnStagedAttempt(proc: PumpProc): Promise<void> {
    proc.attempts += 1;
    proc.attemptSettled = false;
    if (proc.attempts === 1) {
      this.log(proc, 'started', { mode: 'staged' });
    }

    // A staged retry restarts the download from zero: fresh fifos, fresh
    // feeders — a replay VOD re-broadcasts from its beginning rather than
    // resuming mid-stream (documented v1 limitation; acceptable for the
    // short clips this pumps).
    const fifos = stagedFifoPaths();
    try {
      await Promise.all([
        makeFifo(fifos.video),
        makeFifo(fifos.audio),
        makeFifo(fifos.flv),
      ]);
    } catch (error) {
      this.unlinkFifoPaths(fifos);
      throw error;
    }
    proc.flvFifo = fifos.flv;
    if (proc.stopping) {
      // stop() won the race before anything was spawned — nothing to kill.
      this.unlinkFifoPaths(fifos);
      proc.starting = false;
      return;
    }
    proc.fifos = fifos;

    let videoHandle: FileHandle | null = null;
    let audioHandle: FileHandle | null = null;
    try {
      // (2) The unsandboxed publisher spawns first (its pending flv read-end
      // pairs when ffmpeg opens the output below)…
      proc.publisher = spawn(
        FFMPEG_BIN,
        buildPublisherArgs({
          flvFifo: fifos.flv,
          dest: proc.params.dest,
        }),
        { stdio: ['ignore', 'pipe', 'pipe'], detached: true }
      );
      this.attachPublisherHandlers(proc, proc.publisher);

      // (3) …then the sandboxed ffmpeg spawns, writing FLV to the flv fifo.
      const child = await guardedSpawn(
        FFMPEG_BIN,
        buildStagedPumpArgs({
          videoFifo: fifos.video,
          audioFifo: fifos.audio,
          outFifo: fifos.flv,
        }),
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      proc.child = child;
      proc.running = true;
      this.attachFfmpegHandlers(proc, child);

      // (3)+(4) Video write-end, then the video feeder AT ONCE — its bytes
      // are what lets ffmpeg's probe of v.fifo complete (and with it the
      // opening of a.fifo's read-end below).
      videoHandle = await this.openFifoWriteEnd(proc, child, fifos.video);
      await this.spawnFeeder(proc, 'video', videoHandle);

      if (proc.stopping) {
        // stop() already signalled ffmpeg; its close settled this attempt.
        this.teardownStagedAttempt(proc);
        return;
      }

      // (5) Audio write-end — it can only pair once ffmpeg reaches input 1,
      // i.e. right after the video probe completes — then the audio feeder.
      audioHandle = await this.openFifoWriteEnd(proc, child, fifos.audio);
      await this.spawnFeeder(proc, 'audio', audioHandle);
      proc.starting = false;
    } catch (error) {
      if (!proc.attemptSettled && !proc.stopping) {
        // Setup failed without any child death owning the attempt — tear the
        // half-built attempt down here, then classify:
        this.teardownStagedAttempt(proc);
        if (error instanceof OpenTimeoutError) {
          // A probe-phase timeout is transient (slow-CDN first burst): it
          // settles into the normal retry path — full teardown already
          // happened, the retry creates fresh fifos and restarts the
          // download from zero (documented v1 limitation).
          this.failStagedSetup(proc, error);
          return;
        }
        // Anything else (mkfifo failure, yt-dlp unavailable) cannot
        // self-heal — rethrow for the caller's spawn_failed handling.
      }
      throw error;
    } finally {
      // The parent's copies of the write-end fds are always closed: after a
      // successful spawn the child holds its own dup; on failure a leaked
      // write-end would keep ffmpeg from ever seeing EOF.
      if (videoHandle) void videoHandle.close().catch(() => {});
      if (audioHandle) void audioHandle.close().catch(() => {});
    }
  }

  /**
   * Opens one fifo write-end for the parent — a blocking O_WRONLY open that
   * pairs with ffmpeg's read-end open. Raced against ffmpeg failing to
   * start/dying before the pair forms and a per-phase timeout, so a dead
   * attempt never pins libuv threadpool threads on an open that can never
   * complete (the still-pending open is rescued in `unblockPendingOpens`).
   * `proc.pendingOpens` stays populated while the open is in flight so every
   * teardown path can rescue it.
   */
  private async openFifoWriteEnd(
    proc: PumpProc,
    child: ChildProcess,
    fifoPath: string
  ): Promise<FileHandle> {
    const opening = fsOpen(fifoPath, fsConstants.O_WRONLY);
    proc.pendingOpens = [opening];
    const handle = (await Promise.race([
      opening,
      this.setupFailureGuard(child),
      this.openPhaseTimeout(),
    ])) as FileHandle;
    proc.pendingOpens = [];
    if (proc.attemptSettled || proc.stopping) {
      // The attempt died while this open was resolving (e.g. a feeder death
      // tore it down and the rescue paired this open) — the handle is ours
      // to close; using it would spawn a feeder into a dead attempt.
      void handle.close().catch(() => {});
      throw new Error('the attempt ended while the source pipe was opening');
    }
    return handle;
  }

  /** Per-phase deadline for one write-end open (see `openFifoWriteEnd`). */
  private openPhaseTimeout(): Promise<never> {
    return new Promise((_, reject) => {
      const timer = setTimeout(() => {
        reject(
          new OpenTimeoutError(
            'timed out waiting for ffmpeg to open the source pipes'
          )
        );
      }, FIFO_OPEN_TIMEOUT_MS);
      timer.unref?.();
    });
  }

  /** Rejects when ffmpeg cannot start or dies before the write-ends are open. */
  private setupFailureGuard(child: ChildProcess): Promise<never> {
    return new Promise((_, reject) => {
      child.once('error', (error: Error) =>
        reject(new Error(`could not start ffmpeg: ${error.message}`))
      );
      child.once('close', () =>
        reject(new Error('ffmpeg exited before the source pipes were ready'))
      );
    });
  }

  /**
   * Spawns one feeder with the fifo write-end fd as its stdout, trying the
   * yt-dlp candidates in lookup order. The child is registered and watched
   * as soon as it spawns so even an instant exit is seen.
   */
  private async spawnFeeder(
    proc: PumpProc,
    kind: FeederKind,
    fifoHandle: FileHandle
  ): Promise<ChildProcess> {
    const failures: string[] = [];
    for (const candidate of feederCandidates(proc.params.source, kind)) {
      let child: ChildProcess;
      try {
        child = await guardedSpawn(candidate.command, candidate.args, {
          // stdio[1] is the fifo write-end fd: the feeder's stdout IS the
          // pipe — yt-dlp writes the media bytes straight into it.
          stdio: ['ignore', fifoHandle.fd, 'pipe'],
          shell: false,
        });
      } catch (error) {
        // Spawn throws only on invalid arguments; real lookup failures emit
        // 'error' asynchronously (handled below).
        failures.push(
          `${candidate.command}: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      // Register the child before the handshake so even an instant exit or a
      // stop() racing this window finds it in the attempt's process list.
      proc.feeders.push(child);
      this.watchFeeder(proc, child, kind);
      const outcome = await new Promise<'spawned' | Error>((resolve) => {
        child.once('error', (error: Error) => resolve(error));
        child.once('spawn', () => resolve('spawned'));
      });
      if (outcome !== 'spawned') {
        // This candidate never ran — drop it from the attempt's process list
        // and let the next candidate in the lookup order take over.
        proc.feeders = proc.feeders.filter((tracked) => tracked !== child);
        failures.push(`${candidate.command}: ${outcome.message}`);
        continue;
      }
      if (proc.attemptSettled || proc.stopping) {
        // The child died instantly (its close settled the attempt) or the
        // pump is being stopped — no point trying the next candidate.
        throw new Error(`the ${kind} feeder could not start`);
      }
      return child;
    }
    throw new Error(
      `could not start the ${kind} feeder (yt-dlp unavailable?): ${
        failures.join('; ') || 'no candidates'
      }`
    );
  }

  /**
   * Feeder lifecycle: stderr joins the redacted tail and the watchdog (a
   * bot-check/sign-in error can never succeed on retry → fatal, no retry);
   * a non-zero exit is treated like a crashed ffmpeg and triggers the
   * existing retry path. An exit 0 is normal — the source finished (a VOD
   * broadcasts once through) and ffmpeg EOFs on its own.
   */
  private watchFeeder(
    proc: PumpProc,
    child: ChildProcess,
    kind: FeederKind
  ): void {
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = redactStreamKey(chunk.toString(), proc.params.dest);
      proc.tail = (proc.tail + text).slice(-STDERR_TAIL_CHARS);
      if (proc.attemptSettled || proc.stopping) return;
      const fatal = this.feederFatalSignature(proc.tail);
      if (fatal) {
        proc.fatalError = `the ${kind} feeder reported a fatal error ("${fatal}") — giving up without retry.`;
        this.log(proc, 'fatal', { error: proc.fatalError });
        this.killAttemptProcs(proc);
      }
    });
    child.once('error', (error: Error) => {
      // Spawn failures are consumed by the candidate handshake in
      // spawnFeeder; a mid-run error is only recorded — the process's own
      // close follows.
      if (!child.pid) return;
      const text = redactStreamKey(error.message, proc.params.dest);
      proc.tail = (proc.tail + text).slice(-STDERR_TAIL_CHARS);
    });
    child.once('close', (code: number | null) => {
      // Never-spawned candidates (pid undefined) are the handshake's business.
      if (!child.pid) return;
      if (proc.attemptSettled || proc.stopping || proc.fatalError) return;
      if (code === 0) return;
      this.failAttempt(
        proc,
        `the ${kind} feeder exited with code ${code}`,
        code ?? 1
      );
    });
  }

  /**
   * Finds the first fatal feeder signature in an ERROR line of the redacted
   * tail. Scanning the accumulated tail (not just the newest chunk) catches
   * error lines that arrived split across pipe reads; a fatal signature
   * settles the attempt the first time it appears, so rescanning the tail
   * cannot double-fire.
   */
  private feederFatalSignature(tail: string): string | null {
    for (const line of tail.slice(-2_000).toLowerCase().split('\n')) {
      if (!line.trimStart().startsWith('error:')) continue;
      const fatal = FEEDER_FATAL_STDERR_SIGNATURES.find((signature) =>
        line.includes(signature)
      );
      if (fatal) return fatal;
    }
    return null;
  }

  /**
   * A feeder died mid-stream: kill the rest of the attempt, then settle it
   * through the same state machine as a crashed ffmpeg (retry with backoff,
   * budget capped at RETRY_BACKOFF_MS.length).
   */
  private failAttempt(proc: PumpProc, message: string, code: number): void {
    if (!this.markAttemptSettled(proc)) return;
    this.log(proc, 'feeder_failed', { error: message, code });
    proc.tail = (proc.tail + message).slice(-STDERR_TAIL_CHARS);
    proc.running = false;
    if (proc.killTimer) {
      clearTimeout(proc.killTimer);
      proc.killTimer = null;
    }
    // killAttemptProcs signals the still-live ffmpeg and nulls proc.child —
    // nulling it here first would leak the process.
    this.teardownStagedAttempt(proc);
    this.settleAttempt(proc, code);
  }

  /**
   * A staged setup failed transiently — a probe-phase timeout on a slow CDN,
   * or a retry's setup broke (mkfifo/yt-dlp vanished mid-retry): settle it
   * like a crash so the retry budget still applies. The attempt was already
   * torn down by the caller.
   */
  private failStagedSetup(proc: PumpProc, error: unknown): void {
    if (!this.markAttemptSettled(proc)) return;
    const text = redactStreamKey(
      error instanceof Error ? error.message : String(error),
      proc.params.dest
    );
    proc.tail = (proc.tail + text).slice(-STDERR_TAIL_CHARS);
    proc.running = false;
    this.teardownStagedAttempt(proc);
    this.settleAttempt(proc, 1);
  }

  /** First caller wins the once-per-attempt terminal decision. */
  private markAttemptSettled(proc: PumpProc): boolean {
    if (proc.attemptSettled) return false;
    proc.attemptSettled = true;
    return true;
  }

  // ---------------------------------------------------------------- cleanup

  /** SIGKILLs every child of the attempt — feeders, publisher, then ffmpeg. */
  private killAttemptProcs(proc: PumpProc): void {
    for (const feeder of proc.feeders) signalProcessTree(feeder, 'SIGKILL');
    proc.feeders = [];
    if (proc.publisher) {
      signalProcessTree(proc.publisher, 'SIGKILL');
      proc.publisher = null;
    }
    if (proc.child) {
      signalProcessTree(proc.child, 'SIGKILL');
      proc.child = null;
    }
  }

  /**
   * Tears down one attempt's pipes and leftover children — idempotent,
   * best-effort, and shared by every staged exit path (setup failure, close,
   * fatal, stop). For direct pumps (no feeders, no fifos) it is a no-op.
   */
  private teardownStagedAttempt(proc: PumpProc): void {
    proc.starting = false;
    proc.running = false;
    const pending = proc.pendingOpens;
    proc.pendingOpens = [];
    if (pending.length && proc.fifos) {
      void this.unblockPendingOpens(proc.fifos, pending);
    }
    this.killAttemptProcs(proc);
    this.unlinkFifos(proc);
    this.unlinkFlvFifo(proc);
  }

  /**
   * A blocking O_WRONLY fifo open pins a libuv threadpool thread until a
   * reader appears. If an attempt dies before ffmpeg opened its read-ends,
   * the still-pending parent opens would never complete — open non-blocking
   * read-ends here (O_NONBLOCK read-opens never wait) to pair with them,
   * waking both sides, then close everything.
   */
  private async unblockPendingOpens(
    fifos: FifoPair,
    pending: Promise<FileHandle>[]
  ): Promise<void> {
    await Promise.allSettled([
      fsOpen(fifos.video, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
        .then((handle) => handle.close())
        .catch(() => {
          // best-effort — ignore
        }),
      fsOpen(fifos.audio, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
        .then((handle) => handle.close())
        .catch(() => {
          // best-effort — ignore
        }),
      ...pending.map((opening) =>
        opening
          .then((handle) => handle.close())
          .catch(() => {
            // best-effort — ignore
          })
      ),
    ]);
  }

  /** Unlinks the fifo trio (best-effort, errors ignored) and forgets them. */
  private unlinkFifos(proc: PumpProc): void {
    const fifos = proc.fifos;
    proc.fifos = null;
    if (fifos) this.unlinkFifoPaths(fifos);
    this.unlinkFlvFifo(proc);
  }

  /** Unlinks the flv output fifo (best-effort, errors ignored). */
  private unlinkFlvFifo(proc: PumpProc): void {
    const flvFifo = proc.flvFifo;
    proc.flvFifo = null;
    if (flvFifo) void fsUnlink(flvFifo).catch(() => {});
  }

  private unlinkFifoPaths(fifos: FifoPair): void {
    // Best-effort — the fifos may already be gone; nothing here is fatal.
    for (const fifoPath of [fifos.video, fifos.audio, fifos.flv]) {
      void fsUnlink(fifoPath).catch(() => {
        // ignore
      });
    }
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
      if (proc.params.mode === 'staged') {
        // Staged retry: the previous attempt was fully torn down at settle
        // time; this creates fresh fifos and restarts the download from zero.
        this.spawnStagedAttempt(proc).catch((error) => {
          if (proc.stopping || proc.attemptSettled) return;
          this.failStagedSetup(proc, error);
        });
        return;
      }
      this.spawnAttempt(proc).catch((error) => {
        if (proc.stopping || proc.attemptSettled) return;
        this.failAttempt(
          proc,
          redactStreamKey(
            error instanceof Error ? error.message : String(error),
            proc.params.dest
          ),
          1
        );
      });
    }, delay);
    proc.retryTimer.unref?.();
    this.log(proc, 'retry', { delayMs: delay, retry: proc.retries });
  }

  private async probeSource(
    source: string,
    timeoutMs = 15_000
  ): Promise<VideoStreams> {
    // The probe is a sandboxed process too: its nested requests get the same
    // egress policy as the pump itself.
    const child = await guardedSpawn(
      FFPROBE_BIN,
      ['-v', 'error', '-show_streams', '-of', 'json', source],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return new Promise((resolve) => {
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const timer = setTimeout(
        () => signalProcessTree(child, 'SIGKILL'),
        timeoutMs
      );
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
