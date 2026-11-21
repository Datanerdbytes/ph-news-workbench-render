/**
 * Client for the media runner worker (media-runner.ts, deployed on Fly.io):
 * the separate process that owns the sandboxed native-media work (yt-dlp
 * resolve, the live pump) when the web runtime cannot run the sandbox
 * (Render). Every proxy branch in the live routes is gated on `runnerMode()`
 * — unset locally, so dev keeps the in-process pump and resolver.
 *
 * The shared secret rides as a bearer token; the worker fails closed when it
 * is unconfigured on either side (lib/cron.ts pattern).
 */

export function runnerMode(): boolean {
  return Boolean(process.env.MEDIA_RUNNER_URL?.trim());
}

export function runnerBaseUrl(): string {
  return (process.env.MEDIA_RUNNER_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
}

function requireHttpsRunnerBaseUrl(): string {
  const base = runnerBaseUrl();
  if (!base) throw new Error('The media runner URL is not configured.');
  if (!URL.canParse(base) || new URL(base).protocol !== 'https:') {
    throw new Error('The media runner URL must be a valid HTTPS URL.');
  }
  return base;
}

export function runnerToken(): string {
  return (process.env.MEDIA_RUNNER_TOKEN ?? '').trim();
}

/**
 * What a runner call hands back to the route layer:
 * - `response` — the worker answered; `status`/`body` pass through verbatim
 *   (the worker reproduces each route's JSON contract exactly).
 * - `unreachable` — DNS/connection/timeout failure or a missing
 *   configuration; the route renders a 502 with a stable message.
 */
export type RunnerOutcome =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'unreachable'; error: string };

const RUNNER_TIMEOUT_MS = 60_000;
// yt-dlp itself has a 60s extraction budget. Give /resolve a little room
// for the companion's setup and the round trip instead of racing that limit.
const RESOLVE_RUNNER_TIMEOUT_MS = 75_000;
// Media relays stream for the length of the request (segments are MBs); the
// deadline still bounds each one so a wedged runner can never hold the
// browser's player open forever.
const RUNNER_STREAM_TIMEOUT_MS = 90_000;

/**
 * POSTs JSON to one worker endpoint with the bearer token. Never throws —
 * transport failures come back as `unreachable` so callers can stay on the
 * response path.
 */
export async function runnerRequest(
  path: string,
  body: unknown
): Promise<RunnerOutcome> {
  try {
    const base = requireHttpsRunnerBaseUrl();
    const token = runnerToken();
    if (!token) throw new Error('The media runner token is not configured.');

    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      // A redirect could resend the POST body over HTTP.
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(
        path === '/resolve' ? RESOLVE_RUNNER_TIMEOUT_MS : RUNNER_TIMEOUT_MS
      ),
      cache: 'no-store',
    });
    // fetch resolves at headers, not at the end of the response. The same
    // deadline must cover reading the body, and a broken/timed-out body is
    // a transport failure just like a connection that never sent headers.
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: text.slice(0, 300) };
    }
    return { kind: 'response', status: response.status, body: parsed };
  } catch (error) {
    return {
      kind: 'unreachable',
      error: error instanceof Error ? error.message : 'The media runner request failed.',
    };
  }
}

/** The stable 502 the live routes render when the worker cannot be reached. */
export const RUNNER_UNREACHABLE_ERROR =
  'The media runner is unreachable right now. Try again shortly.';

/**
 * POSTs JSON to one worker endpoint and returns the RAW response — body
 * streaming, never buffered. Used by the preview proxy's media relay: the
 * caller pipes `response.body` straight through to the browser, so any
 * `await response.text()` here would buffer whole segments into memory.
 *
 * The caller's signal and a fixed deadline are combined, so a browser
 * disconnect (hls.js aborting a segment load) tears down the runner request
 * even mid-stream. Transport failures throw — the caller maps them onto its
 * own error contract.
 */
export async function runnerStreamRequest(
  path: string,
  body: unknown,
  signal: AbortSignal
): Promise<Response> {
  const base = requireHttpsRunnerBaseUrl();
  const token = runnerToken();
  if (!token) throw new Error('The media runner token is not configured.');

  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.any([signal, AbortSignal.timeout(RUNNER_STREAM_TIMEOUT_MS)]),
    cache: 'no-store',
  });
}
