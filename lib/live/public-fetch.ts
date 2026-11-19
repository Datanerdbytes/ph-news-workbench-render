import { Agent, fetch as undiciFetch, buildConnector } from 'undici';
import {
  resolvePublicAddresses,
  validateSourceUrl,
  type LookupAddress,
} from './public-network';

const CONNECT_TIMEOUT_MS = 8_000;
const HEADERS_TIMEOUT_MS = 10_000;
const IDLE_READ_TIMEOUT_MS = 15_000;

/**
 * Fetches one already-policy-checked public URL without letting Undici
 * resolve the hostname again — the socket dials a validated address directly
 * while the URL keeps its original host for the HTTP `Host` header and the
 * TLS SNI/certificate identity. This closes the DNS-rebinding gap between a
 * pre-flight check and the actual connection.
 *
 * Redirects are intentionally left to the caller (`redirect: 'manual'`) so
 * every hop is re-validated before dispatch. Each call gets its own
 * short-lived pinned dispatcher, destroyed when the body ends or is
 * cancelled — no pooled agent survives to outlive the policy.
 */
export async function fetchPublicSource(
  value: string,
  init: RequestInit = {}
): Promise<Response> {
  const original = validateSourceUrl(value);
  const parsed = new URL(original);
  const addresses = await resolvePublicAddresses(parsed.hostname);
  const dispatcher = createPinnedDispatcher(parsed.hostname, addresses);

  let upstream: Response;
  try {
    upstream = (await undiciFetch(original, {
      ...init,
      redirect: 'manual',
      dispatcher,
    } as never)) as unknown as Response;
  } catch (error) {
    void dispatcher.destroy(error instanceof Error ? error : null);
    throw error;
  }

  if (!upstream.body) {
    await dispatcher.close();
    return upstream;
  }

  // Wrap the upstream body so the pinned dispatcher is torn down exactly
  // when the consumer finishes or cancels — never leaking a connection that
  // outlives its validated policy.
  const reader = upstream.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          await dispatcher.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        controller.error(error);
        void dispatcher.destroy(error instanceof Error ? error : null);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await dispatcher.destroy(reason instanceof Error ? reason : null);
      }
    },
  });

  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

/**
 * Builds a dispatcher whose TCP connector dials only the validated numeric
 * address. The requested hostname is preserved as TLS `servername` (and the
 * URL keeps the original authority for the `Host` header), so certificates
 * still verify against the real origin while the socket cannot be pointed at
 * a different address by a racing DNS answer.
 */
function createPinnedDispatcher(
  hostname: string,
  addresses: LookupAddress[]
): Agent {
  const pinned = addresses[0];
  if (!pinned) throw new Error('No validated address was available.');

  const defaultConnector = buildConnector({ timeout: CONNECT_TIMEOUT_MS });
  const connect: NonNullable<Agent.Options['connect']> = (options, callback) =>
    defaultConnector(
      {
        ...options,
        hostname: pinned.address,
        host: pinned.address,
        // TLS SNI + certificate identity stay the requested hostname.
        servername: options.servername || normalizeHostname(hostname),
      },
      callback
    );

  return new Agent({
    connect,
    connections: 1,
    maxOrigins: 1,
    pipelining: 0,
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: IDLE_READ_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
    keepAliveTimeout: 1_000,
    keepAliveMaxTimeout: 2_000,
    maxCachedSessions: 0,
  });
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}
