#!/usr/bin/env node

/**
 * Wait until the production app answers on its health endpoint.
 *
 * The health path is the one Render itself is configured to poll (`/login`),
 * which answers 200 without a session. A free-tier instance that has been
 * asleep answers 502 for a while before it wakes, so the check retries until
 * the deadline instead of failing on the first miss.
 */

export const DEFAULT_HEALTH_URL = "https://ph-news-workbench.onrender.com/login";

/**
 * @param {number | undefined} status
 * @returns {boolean}
 */
export function isHealthy(status) {
  return typeof status === "number" && status >= 200 && status < 400;
}

/**
 * The wait between attempts grows with the attempt number so a cold start is
 * not hammered, but stays short enough to stay inside the timeout.
 *
 * @param {number} attempt
 * @returns {number}
 */
export function retryDelayMs(attempt) {
  return Math.min(5_000 * attempt, 30_000);
}

/**
 * @param {{ url: string, timeoutMs: number, requestTimeoutMs?: number, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, log?: (message: string) => void }} options
 */
export async function waitForHealth({
  url,
  timeoutMs,
  requestTimeoutMs = 60_000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastStatus = null;
  let lastError = null;

  for (;;) {
    attempt += 1;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      lastStatus = response.status;
      lastError = null;

      if (isHealthy(response.status)) {
        log(`${url} answered ${response.status} after ${attempt} attempt(s)`);
        return { ok: true, status: response.status, attempts: attempt };
      }

      log(`${url} answered ${response.status} — retrying`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log(`${url} did not answer (${lastError}) — retrying`);
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `${url} did not become healthy in time (last status: ${lastStatus ?? "no response"}${
          lastError ? `, last error: ${lastError}` : ""
        }).`,
      );
    }

    await sleep(retryDelayMs(attempt));
  }
}

async function main() {
  const url = process.env.RENDER_HEALTH_URL || DEFAULT_HEALTH_URL;
  const timeoutMinutes = Number(process.env.RENDER_HEALTH_TIMEOUT_MINUTES || 10);

  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error("RENDER_HEALTH_TIMEOUT_MINUTES must be a positive number of minutes.");
  }

  await waitForHealth({
    url,
    timeoutMs: timeoutMinutes * 60_000,
    log: (message) => console.log(message),
  });

  console.log(`production is healthy at ${url}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
