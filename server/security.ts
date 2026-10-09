import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    // Only global unicast; reject mapped IPv4, local, link-local, documentation,
    // transition, and multicast ranges as browser targets.
    return /^[23][0-9a-f]{3}:/.test(normalized) && !normalized.startsWith('2001:db8:') &&
      !normalized.startsWith('2001:0:') && !normalized.startsWith('2002:');
  }
  return false;
}

export async function assertPublicUrl(value: string): Promise<void> {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a valid application URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Application URLs must use HTTP or HTTPS without embedded credentials.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Local and private network destinations are blocked.');
  }
  const records = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicAddress(record.address))) {
    throw new Error('Local and private network destinations are blocked.');
  }
}
