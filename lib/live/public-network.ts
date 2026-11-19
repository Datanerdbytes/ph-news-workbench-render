import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

/** Mirrors node:dns LookupAddress so callers need no Node-specific types. */
export type LookupAddress = { address: string; family: 4 | 6 };

/**
 * Signed CDN URLs (googlevideo) routinely exceed 2 KB, so the bound here is
 * generous — but a limit exists and oversized input is REJECTED, never
 * silently truncated (truncation drops signature parameters and yields a
 * broken or, worse, differently-addressed request).
 */
export const MAX_SOURCE_URL_LENGTH = 32_768;

export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkPolicyError';
  }
}

/**
 * Client-safe input validation for a source URL. Synchronous and cheap:
 * parses, requires http(s), rejects embedded credentials, control/whitespace
 * characters, non-default ports, and over-length input. Returns the exact
 * original string unchanged — never a re-encoded copy — so signed query
 * parameters survive byte-for-byte.
 *
 * This is input shaping only. It is NOT the SSRF boundary: hostnames must
 * still go through `resolvePublicAddresses` / `assertPublicSourceUrl` at the
 * point a connection is actually made.
 */
export function validateSourceUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SOURCE_URL_LENGTH ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new NetworkPolicyError('That link is not a URL we can preview.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new NetworkPolicyError('That link is not a URL we can preview.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NetworkPolicyError('Only http and https links can be previewed.');
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new NetworkPolicyError('That link is not a URL we can preview.');
  }
  if (
    parsed.port &&
    parsed.port !== (parsed.protocol === 'http:' ? '80' : '443')
  ) {
    throw new NetworkPolicyError(
      'Links on non-standard ports cannot be previewed.'
    );
  }

  return value;
}

/**
 * Resolves a hostname to addresses that are ALL public unicast. Rejects
 * empty answers, resolution failures, and mixed public/private answers
 * (fail closed rather than trusting the first record). IP literals are
 * classified directly without DNS.
 */
export async function resolvePublicAddresses(
  hostname: string
): Promise<LookupAddress[]> {
  const unbracketed =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;

  let addresses: LookupAddress[];
  try {
    const family = isIP(unbracketed);
    if (family) {
      addresses = [{ address: unbracketed, family: family as 4 | 6 }];
    } else {
      addresses = (await lookup(unbracketed, { all: true, verbatim: true })).map(
        (entry) => ({
          address: entry.address,
          family: entry.family === 6 ? 6 : 4,
        })
      );
    }
  } catch {
    throw new NetworkPolicyError(
      'We could not look up that host, so it cannot be previewed.'
    );
  }

  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address, family }) =>
        (family !== 4 && family !== 6) || !isPublicAddress(address, family)
    )
  ) {
    throw new NetworkPolicyError(
      'That link points to a non-public address, so it cannot be previewed here.'
    );
  }

  return addresses;
}

/**
 * Full SSRF check for a source URL: input validation + DNS resolution with
 * the public-only policy. Returns the exact original string. Callers must
 * still connect using the validated addresses (see public-fetch.ts) — a
 * check that is not bound to the socket does not stop DNS rebinding.
 */
export async function assertPublicSourceUrl(value: string): Promise<string> {
  const original = validateSourceUrl(value);
  const parsed = new URL(original);
  await resolvePublicAddresses(parsed.hostname);
  return original;
}

/**
 * Public unicast classification via ipaddr.js ranges. IPv4-mapped IPv6 is
 * judged by its embedded IPv4 address. Unparseable input is never public.
 */
export function isPublicAddress(address: string, family?: number): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (
      family !== undefined &&
      parsed.kind() === 'ipv4' &&
      family !== 4
    ) {
      return false;
    }
    if (
      family !== undefined &&
      parsed.kind() === 'ipv6' &&
      family !== 6
    ) {
      return false;
    }
    if (parsed.kind() === 'ipv6') {
      const v6 = parsed as ipaddr.IPv6;
      if (v6.isIPv4MappedAddress()) {
        return v6.toIPv4Address().range() === 'unicast';
      }
    }
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}
