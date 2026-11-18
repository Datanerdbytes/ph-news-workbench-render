import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * What POST /api/live/resolve hands back to the Live Page preview.
 *
 * `mode: 'direct'` — `playableUrl` is a stream a browser or ffmpeg can open
 * as-is. `mode: 'staged'` — yt-dlp found no playable URL at all (DASH-only
 * sources such as Facebook replay VODs expose only http_dash_segments
 * fragment lists), but the pump can still broadcast it by piping
 * video-only/audio-only feeds through yt-dlp (see staged mode in
 * lib/live/pump.ts): `playableUrl` is null and there is no preview.
 */
export type ResolvedVideo = {
  title: string;
  isLive: boolean;
  playableUrl: string | null;
  mode: 'direct' | 'staged';
  extractor: string;
};

export type ResolveErrorCode =
  | 'invalid_url'
  | 'unavailable'
  | 'auth_required'
  | 'unsupported'
  | 'timeout'
  | 'failed';

export class ResolveError extends Error {
  readonly code: ResolveErrorCode;

  constructor(code: ResolveErrorCode, message: string) {
    super(message);
    this.name = 'ResolveError';
    this.code = code;
  }
}

/** yt-dlp -J on a busy site can stall; past this we kill it and report. */
const RESOLVE_TIMEOUT_MS = 20_000;

/**
 * yt-dlp's `-J` payload. Only the fields the resolver needs are typed; the
 * rest is passed through untouched.
 */
type YtdlpInfo = {
  title?: unknown;
  is_live?: unknown;
  url?: unknown;
  manifest_url?: unknown;
  extractor?: unknown;
  extractor_key?: unknown;
  formats?: {
    url?: unknown;
    protocol?: unknown;
    ext?: unknown;
    vcodec?: unknown;
    acodec?: unknown;
  }[];
};

type YtdlpRun = { code: number | null; stdout: string; stderr: string };

/**
 * Dev machines run yt-dlp inside the YT_DLP venv — the same companion setup
 * download-worker.ts uses. YTDLP_PYTHON overrides the interpreter. Shared
 * with the staged pump's feeder lookup (lib/live/pump.ts).
 */
export function pythonExecutable(): string {
  if (process.env.YTDLP_PYTHON) return process.env.YTDLP_PYTHON;
  const suffix = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  return path.join(os.homedir(), 'python-project', 'Projects', 'YT_DLP', 'my_venv', suffix);
}

/**
 * Where to find yt-dlp, in order: an explicit YTDLP_PATH, the binary on PATH
 * (this is what the Dockerfile installs), then the local venv. The URL is
 * always the last argv element and stays a single element.
 */
function ytDlpCandidates(url: string): { command: string; args: string[] }[] {
  // `--js-runtimes node` mirrors download-worker.ts buildYtdlpArgs — recent
  // yt-dlp needs a JS runtime for sites whose challenge code runs in JS
  // (required for YouTube).
  const args = ['-J', '--no-playlist', '--js-runtimes', 'node', url];
  const candidates: { command: string; args: string[] }[] = [];
  const envPath = process.env.YTDLP_PATH?.trim();
  if (envPath) candidates.push({ command: envPath, args });
  candidates.push({ command: 'yt-dlp', args });
  candidates.push({
    command: pythonExecutable(),
    args: ['-m', 'yt_dlp', ...args],
  });
  return candidates;
}

/** The binary at this location could not start at all (ENOENT, EACCES, …). */
class SpawnUnavailableError extends Error {}

/**
 * Runs one yt-dlp candidate to completion. Spawn failures reject with
 * SpawnUnavailableError (caller tries the next candidate); a stall rejects
 * with ResolveError `timeout` after killing the child.
 */
function runYtdlp(command: string, args: string[]): Promise<YtdlpRun> {
  return new Promise((resolve, reject) => {
    // shell: false keeps the URL one argv element — never shell-interpolated.
    const child: ChildProcess = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RESOLVE_TIMEOUT_MS);
    timer.unref();
    child.once('error', () => {
      clearTimeout(timer);
      reject(new SpawnUnavailableError());
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new ResolveError(
            'timeout',
            'The video link took too long to resolve. Try again in a moment.'
          )
        );
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/** Audio and video in one http(s) file — plays in every browser as-is. */
function isProgressiveFormat(format: {
  url?: unknown;
  protocol?: unknown;
  vcodec?: unknown;
  acodec?: unknown;
}): boolean {
  return (
    isHttpUrl(format.url) &&
    (format.protocol === 'http' || format.protocol === 'https') &&
    typeof format.vcodec === 'string' &&
    format.vcodec !== 'none' &&
    typeof format.acodec === 'string' &&
    format.acodec !== 'none'
  );
}

/** HLS manifest formats are what live streams and hls.js/ffmpeg need. */
function isManifestFormat(format: { url?: unknown; protocol?: unknown }): boolean {
  const protocol = typeof format.protocol === 'string' ? format.protocol : '';
  return isHttpUrl(format.url) && /m3u8|hls/i.test(protocol);
}

function pickPlayableUrl(info: YtdlpInfo): string | null {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  if (info.is_live === true) {
    // Live sources only make sense through their manifest.
    const manifest = formats.find(isManifestFormat);
    if (manifest && isHttpUrl(manifest.url)) return manifest.url;
    if (isHttpUrl(info.manifest_url)) return info.manifest_url;
  } else {
    // VOD: prefer a progressive mp4, then any progressive file, then a
    // manifest the player/ffmpeg can adapt from.
    const mp4 = formats.find(
      (format) => isProgressiveFormat(format) && format.ext === 'mp4'
    );
    if (mp4 && isHttpUrl(mp4.url)) return mp4.url;
    const progressive = formats.find(isProgressiveFormat);
    if (progressive && isHttpUrl(progressive.url)) return progressive.url;
    const manifest = formats.find(isManifestFormat);
    if (manifest && isHttpUrl(manifest.url)) return manifest.url;
    if (isHttpUrl(info.manifest_url)) return info.manifest_url;
  }
  if (isHttpUrl(info.url)) return info.url;
  return null;
}

/**
 * Maps yt-dlp's failure output onto the resolver error codes. Only friendly
 * English reaches callers — raw stderr never leaves this module's run().
 */
function classifyFailure(stderr: string): ResolveError {
  const message = stderr.toLowerCase();
  if (
    /video unavailable|private video|removed by the uploader|has been removed|no longer available/.test(
      message
    )
  ) {
    return new ResolveError(
      'unavailable',
      'That video is unavailable — it may have been removed or made private.'
    );
  }
  if (
    /sign in|log in|login|age.restrict|confirm your age|not a bot|cookies|join this channel|members[- ]only/.test(
      message
    )
  ) {
    return new ResolveError(
      'auth_required',
      'The source site is asking for a sign-in or a bot check the server cannot complete. Try another public link.'
    );
  }
  if (/unsupported url|is not a valid url/.test(message)) {
    return new ResolveError(
      'unsupported',
      'That link is not a supported video page.'
    );
  }
  return new ResolveError('failed', 'The video link could not be resolved.');
}

/**
 * Resolves a public video link to the stream address behind it by running
 * `yt-dlp -J --no-playlist <url>`. Live streams resolve to their HLS
 * manifest, VODs to a progressive mp4 (falling back to a manifest). A source
 * with no playable URL at all classifies as `staged` — still a success, the
 * pump pipes it through yt-dlp feeders.
 */
export async function resolveVideoUrl(url: string): Promise<ResolvedVideo> {
  const target = typeof url === 'string' ? url.trim() : '';
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new ResolveError(
      'invalid_url',
      'Paste a full video link starting with http:// or https://.'
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ResolveError(
      'invalid_url',
      'Only http:// and https:// video links can be resolved.'
    );
  }

  let run: YtdlpRun | null = null;
  for (const candidate of ytDlpCandidates(target)) {
    try {
      run = await runYtdlp(candidate.command, candidate.args);
      break;
    } catch (error) {
      if (error instanceof ResolveError) throw error;
      // This binary could not start — try the next one in the lookup order.
    }
  }
  if (!run) {
    throw new ResolveError(
      'failed',
      'yt-dlp is not available on the server, so the link cannot be resolved.'
    );
  }

  if (run.code !== 0) {
    throw classifyFailure(run.stderr);
  }

  let info: YtdlpInfo;
  try {
    info = JSON.parse(run.stdout) as YtdlpInfo;
  } catch {
    throw new ResolveError('failed', 'The video link could not be resolved.');
  }

  const title =
    typeof info.title === 'string' && info.title.trim()
      ? info.title
      : 'Untitled video';
  const extractor =
    typeof info.extractor_key === 'string' && info.extractor_key
      ? info.extractor_key
      : typeof info.extractor === 'string' && info.extractor
        ? info.extractor
        : 'unknown';

  const playableUrl = pickPlayableUrl(info);
  if (!playableUrl) {
    // No progressive/HLS format, no manifest_url, no top-level url — the
    // DASH-only shape Facebook replay VODs return. Not an error: the pump
    // can pipe these through two yt-dlp feeder processes (staged mode), so
    // we hand back a successful classification instead of failing. The
    // preview is unavailable for such sources; going live still works.
    return { title, isLive: info.is_live === true, playableUrl: null, mode: 'staged', extractor };
  }

  return {
    title,
    isLive: info.is_live === true,
    playableUrl,
    mode: 'direct',
    extractor,
  };
}
