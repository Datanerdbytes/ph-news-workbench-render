import { lookup } from 'node:dns/promises';

/**
 * Server-only side of the preview proxy: the SSRF guard. Never import this
 * from client components — it pulls Node built-ins.
 */
export class PreviewProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewProxyError';
  }
}
/**
 * SSRF guard for the preview proxy: the URL must parse, be http(s), and
 * resolve (DNS) only to public addresses. Loopback, private, link-local,
 * unique-local, unspecified, and IPv4-mapped-IPv6 equivalents are refused.
 * Returns the normalized URL on success; throws PreviewProxyError with a
 * friendly message otherwise.
 */
export async function assertPublicUrl(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PreviewProxyError('That link is not a URL we can preview.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PreviewProxyError(
      'Only http and https links can be previewed.'
    );
  }

  let addresses;
  try {
    // getaddrinfo resolves IP literals directly, so hostname-vs-IP needs
    // no special casing here.
    addresses = await lookup(parsed.hostname, { all: true });
  } catch {
    throw new PreviewProxyError(
      'We could not look up that host, so it cannot be previewed.'
    );
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new PreviewProxyError(
        'That link points to a private address, so it cannot be previewed here.'
      );
    }
  }
  return parsed.href;
}

/**
 * True when the resolved address would let the proxy reach the machine
 * itself or the local network (cloud metadata, developer services, …).
 * Unparseable addresses count as private — never trusted by default.
 */
function isPrivateAddress(address: string): boolean {
  const bytes = parseAddressBytes(address);
  if (bytes === null) return true;
  return bytes.length === 4 ? isPrivateIpv4(bytes) : isPrivateIpv6(bytes);
}

/** Numeric IPv4 value, or null when the string is not a dotted quad. */
function parseIpv4Bytes(address: string): Uint8Array | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (const [index, part] of parts.entries()) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    bytes[index] = octet;
  }
  return bytes;
}

const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

/**
 * 16-byte IPv6 address, or null when the string is not IPv6. Understands
 * `::` compression and dotted-quad tails (`::ffff:127.0.0.1`).
 */
function parseIpv6Bytes(address: string): Uint8Array | null {
  // Replace a dotted-quad tail with its two hex groups so one parser
  // handles both `::1` and `::ffff:10.0.0.1`.
  const dottedTail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  let text = address;
  if (dottedTail) {
    const tail = parseIpv4Bytes(dottedTail[2]);
    if (tail === null) return null;
    const hi = (tail[0]! << 8) | tail[1]!;
    const lo = (tail[2]! << 8) | tail[3]!;
    text = `${dottedTail[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null; // more than one '::'
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (
    head.some((group) => !HEX_GROUP.test(group)) ||
    tail.some((group) => !HEX_GROUP.test(group))
  ) {
    return null;
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;

  const groups = [
    ...head,
    ...Array<string>(halves.length === 2 ? missing : 0).fill('0'),
    ...tail,
  ].map((group) => parseInt(group, 16));

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

/** IPv4 (4 bytes) or IPv6 (16 bytes) address bytes, or null. */
function parseAddressBytes(address: string): Uint8Array | null {
  return parseIpv4Bytes(address) ?? parseIpv6Bytes(address);
}

function isPrivateIpv4(bytes: Uint8Array): boolean {
  const first = bytes[0]!;
  const second = bytes[1]!;
  return (
    (first === 0 && bytes[2] === 0 && bytes[3] === 0) || // 0.0.0.0 — unspecified
    first === 127 || // loopback 127/8
    first === 10 || // private 10/8
    (first === 172 && second >= 16 && second <= 31) || // private 172.16/12
    (first === 192 && second === 168) || // private 192.168/16
    (first === 169 && second === 254) // link-local 169.254/16
  );
}

function isPrivateIpv6(bytes: Uint8Array): boolean {
  if (bytes.every((byte) => byte === 0)) return true; // :: unspecified
  if (
    bytes
      .slice(0, 15)
      .every((byte) => byte === 0) &&
    bytes[15] === 1
  ) {
    return true; // ::1 loopback
  }
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) {
    return true; // fe80::/10 link-local
  }
  if ((bytes[0]! & 0xfe) === 0xfc) {
    return true; // fc00::/7 unique-local
  }
  if (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    // ::ffff:0:0/96 — IPv4-mapped, judge it by the embedded IPv4 address.
    return isPrivateIpv4(bytes.slice(12));
  }
  return false;
}
