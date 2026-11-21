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
 * Builds a dispatcher whose TCP connector dials only validated numeric
 * addresses. The requested hostname is preserved as TLS `servername` (and the
 * URL keeps the original authority for the `Host` header), so certificates
 * still verify against the real origin while the socket cannot be pointed at
 * a different address by a racing DNS answer.
 *
 * The dial tries the validated addresses in sequence until one connects.
 * A pinned literal has no Happy-Eyeballs family fallback — and CDN hosts
 * answer DNS per region, so a runtime with no IPv6 egress (Render) can be
 * handed an IPv6-first answer for an edge host (googlevideo `rrN---sn-…`)
 * while the same resolver keeps `manifest.googlevideo.com` IPv4-first.
 * Pinning only `addresses[0]` then strands every request on the dead
 * family, which surfaced as a 502 on every HLS segment while the manifest
 * itself kept loading. IPv4 is dialed first because server runtimes
 * commonly have IPv4-only egress; the other family stays reachable as a
 * fallback, and every candidate is already policy-validated.
 */
function createPinnedDispatcher(
  hostname: string,
  addresses: LookupAddress[]
): Agent {
  if (addresses.length === 0) {
    throw new Error('No validated address was available.');
  }
  const ordered = [...addresses].sort((a, b) =>
    a.family === b.family ? 0 : a.family === 4 ? -1 : 1
  );

  const defaultConnector = buildConnector({ timeout: CONNECT_TIMEOUT_MS });
  const connect: NonNullable<Agent.Options['connect']> = (options, callback) => {
    // Exactly one callback fires: the first successful dial, or the last
    // error after every validated address has been tried.
    let index = 0;
    const attempt = (previous?: unknown) => {
      if (index >= ordered.length) {
        callback(
          previous instanceof Error
            ? previous
            : new Error('No validated address could be dialed.'),
          null
        );
        return;
      }
      const target = ordered[index++];
      defaultConnector(
        {
          ...options,
          hostname: target.address,
          host: target.address,
          // TLS SNI + certificate identity stay the requested hostname.
          servername: options.servername || normalizeHostname(hostname),
        },
        (error, socket) => {
          if (error) {
            attempt(error);
            return;
          }
          callback(null, socket);
        }
      );
    };
    attempt();
  };

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
