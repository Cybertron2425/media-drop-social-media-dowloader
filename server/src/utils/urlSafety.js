import dns from 'node:dns/promises';
import net from 'node:net';

// Private / reserved / loopback / link-local / broadcast ranges to block for SSRF protection.
const BLOCKED_IPV4_RANGES = [
  { base: '0.0.0.0', bits: 8 },       // Current network (only valid as source)
  { base: '10.0.0.0', bits: 8 },      // Private-use (RFC 1918)
  { base: '100.64.0.0', bits: 10 },   // Shared Address Space (CGNAT)
  { base: '127.0.0.0', bits: 8 },     // Loopback
  { base: '169.254.0.0', bits: 16 },  // Link-local / Cloud metadata (e.g. AWS/GCP 169.254.169.254)
  { base: '172.16.0.0', bits: 12 },   // Private-use (RFC 1918)
  { base: '192.0.0.0', bits: 24 },    // IETF Protocol Assignments
  { base: '192.168.0.0', bits: 16 },  // Private-use (RFC 1918)
  { base: '198.18.0.0', bits: 15 },   // Benchmarking
  { base: '224.0.0.0', bits: 4 },     // Multicast
  { base: '240.0.0.0', bits: 4 },     // Reserved (former Class E)
  { base: '255.255.255.255', bits: 32 }, // Limited broadcast
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
  if (lower === '::1' || lower === '::') {
    return true;
  }
  // Check IPv4-mapped IPv6 address (e.g. ::ffff:127.0.0.1 or ::ffff:169.254.169.254)
  if (lower.startsWith('::ffff:')) {
    const ipv4Part = lower.slice(7);
    if (net.isIPv4(ipv4Part)) {
      return isBlockedIpv4(ipv4Part);
    }
  }
  return (
    lower.startsWith('fe80:') || // link-local
    lower.startsWith('fc') ||    // unique local (fc00::/7)
    lower.startsWith('fd')
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

  // Reject embedded credentials in URL to avoid URL confusion/leaks
  if (parsed.username || parsed.password) {
    throw new Error('This URL cannot be processed.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('This URL cannot be processed.');
  }

  // Restrict destination ports to standard web ports to prevent intranet port scanning
  if (parsed.port && !['80', '443', '8080', '8443'].includes(parsed.port)) {
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
