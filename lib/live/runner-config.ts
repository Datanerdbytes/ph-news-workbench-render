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

/**
 * POSTs JSON to one worker endpoint with the bearer token. Never throws —
 * transport failures come back as `unreachable` so callers can stay on the
 * response path.
 */
export async function runnerRequest(
  path: string,
  body: unknown
): Promise<RunnerOutcome> {
  const base = runnerBaseUrl();
  const token = runnerToken();
  if (!base) {
    return { kind: 'unreachable', error: 'The media runner URL is not configured.' };
  }
  if (!token) {
    return { kind: 'unreachable', error: 'The media runner token is not configured.' };
  }

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
      // Resolve runs yt-dlp (20s budget) and start can spend time inside
      // ffprobe/staged setup before answering — 60s covers both.
      signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    return {
      kind: 'unreachable',
      error: error instanceof Error ? error.message : 'The media runner request failed.',
    };
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text.slice(0, 300) };
  }
  return { kind: 'response', status: response.status, body: parsed };
}

/** The stable 502 the live routes render when the worker cannot be reached. */
export const RUNNER_UNREACHABLE_ERROR =
  'The media runner is unreachable right now. Try again shortly.';
