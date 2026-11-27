import { avatarLimits } from "./config";

const REQUEST_MARGIN_MS = 250;
const DEFAULT_BACKOFF_MS = 60_000;

let requestTail: Promise<void> = Promise.resolve();
let nextRequestAt = 0;

function requestIntervalMs(): number {
  return (
    Math.ceil(60_000 / avatarLimits().apiRequestsPerMinute) +
    REQUEST_MARGIN_MS
  );
}

export async function waitForAvatarRequest(): Promise<void> {
  const previous = requestTail;
  let release!: () => void;
  requestTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    // Recheck the deadline after every sleep: a 429 that lands while this
    // waiter sleeps extends nextRequestAt, and one long sleep would resume
    // before the provider's backoff has ended.
    let delay = nextRequestAt - Date.now();
    while (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      delay = nextRequestAt - Date.now();
    }
    nextRequestAt = Date.now() + requestIntervalMs();
  } finally {
    release();
  }
}

function retryAfterMs(response: Response): number {
  const value = response.headers.get("retry-after");
  if (!value) return DEFAULT_BACKOFF_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - Date.now())
    : DEFAULT_BACKOFF_MS;
}

export function deferAvatarRequests(response: Response): void {
  if (response.status !== 429) return;
  nextRequestAt = Math.max(
    nextRequestAt,
    Date.now() + retryAfterMs(response),
  );
}
