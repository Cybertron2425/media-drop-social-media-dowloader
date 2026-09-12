import dns from 'node:dns/promises';
import net from 'node:net';

// Private / reserved / loopback / link-local ranges to block for SSRF protection.
const BLOCKED_IPV4_RANGES = [
  { base: '0.0.0.0', bits: 8 },
  { base: '10.0.0.0', bits: 8 },
  { base: '100.64.0.0', bits: 10 }, // CGNAT
  { base: '127.0.0.0', bits: 8 },
  { base: '169.254.0.0', bits: 16 },
  { base: '172.16.0.0', bits: 12 },
  { base: '192.0.0.0', bits: 24 },
  { base: '192.168.0.0', bits: 16 },
  { base: '198.18.0.0', bits: 15 },
  { base: '224.0.0.0', bits: 4 }, // multicast
];

function ipToLong(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isIpv4InRange(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(base) & mask);
}

export function isBlockedIpv4(ip) {
  return BLOCKED_IPV4_RANGES.some((r) => isIpv4InRange(ip, r.base, r.bits));
}

export function isBlockedIpv6(ip) {
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower.startsWith('fe80:') || // link-local
    lower.startsWith('fc') ||
    lower.startsWith('fd') || // unique local
    lower.startsWith('::ffff:127.') ||
    lower.startsWith('::ffff:10.') ||
    lower.startsWith('::ffff:192.168.')
  );
}

/**
 * Validates a user-supplied URL is http(s), well-formed, and does not resolve
 * to a private/loopback/link-local address (SSRF protection).
 * Throws with a user-safe message on failure.
 */
export async function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Please enter a valid media URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Please enter a valid media URL.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('This URL cannot be processed.');
  }

  // If the hostname is already a literal IP, check it directly.
  if (net.isIP(hostname)) {
    if (net.isIP(hostname) === 4 && isBlockedIpv4(hostname)) {
      throw new Error('This URL cannot be processed.');
    }
    if (net.isIP(hostname) === 6 && isBlockedIpv6(hostname)) {
      throw new Error('This URL cannot be processed.');
    }
    return parsed;
  }

  // Otherwise resolve DNS and check every returned address (defends against
  // DNS rebinding to a private address).
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('This video cannot be downloaded from this source.');
  }

  for (const { address, family } of addresses) {
    if (family === 4 && isBlockedIpv4(address)) {
      throw new Error('This URL cannot be processed.');
    }
    if (family === 6 && isBlockedIpv6(address)) {
      throw new Error('This URL cannot be processed.');
    }
  }

  return parsed;
}
