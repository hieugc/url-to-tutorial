import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Defense-in-depth preflight for a future isolated cloud worker.
 * DNS lookup alone cannot prevent rebinding, proxy bypass, or connections
 * initiated by browser subresources; never expose the current Studio publicly.
 */
export function isBlockedIp(input) {
  const ip = String(input || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice(7);
    if (isIP(mapped) === 4) return isBlockedIp(mapped);
  }
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 168 || b === 0 && c === 0 || b === 0 && c === 2)) return true;
    if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    return false;
  }
  if (isIP(ip) === 6) {
    if (ip === '::' || ip === '::1') return true;
    const first = Number.parseInt(ip.split(':')[0] || '0', 16);
    if (first >= 0xfc00 || first >= 0xfe80 && first <= 0xfebf || first >= 0xff00) return true;
    if (ip.startsWith('2001:db8:') || ip.startsWith('2001:0db8:')) return true;
    // Conservatively deny unspecified, site-local, documentation and
    // unrecognized addresses; cloud workers should enforce IP egress at network layer.
    // Globally routable IPv6 unicast lives under 2000::/3. Keep the
    // explicit exclusions above; unknown other ranges remain blocked.
    return !(first >= 0x2000 && first <= 0x3fff);
  }
  return true;
}

export async function publicUrlPreflight(value, resolve = lookup) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid public URL'); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.port && url.port !== '443') {
    throw new Error('Hosted mode requires HTTPS, standard port and no credentials');
  }
  if (url.hostname.toLowerCase() === 'localhost' ||
      url.hostname.toLowerCase().endsWith('.localhost') ||
      url.hostname.toLowerCase().endsWith('.local')) {
    throw new Error('Local hostnames are not permitted for cloud egress');
  }
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] :
    await resolve(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(record => isBlockedIp(record.address))) {
    throw new Error('Private, reserved, or unresolvable destination is prohibited');
  }
  return url.href;
}
