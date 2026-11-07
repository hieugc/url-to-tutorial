import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function ipv4Value(input) {
  if (isIP(input) !== 4) return null;
  return input.split('.').reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);
}

function ipv6Value(input) {
  if (isIP(input) !== 6 || input.includes('%')) return null;
  let address = input.toLowerCase();
  if (address.includes('.')) {
    const split = address.lastIndexOf(':');
    const embedded = ipv4Value(address.slice(split + 1));
    if (embedded === null) return null;
    address = address.slice(0, split + 1) +
      ((embedded >> 16n).toString(16)) + ':' + (embedded & 0xffffn).toString(16);
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0 || halves.length === 2 && missing < 1) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
}

function inCidr(value, network, prefix, bits) {
  const shift = BigInt(bits - prefix);
  return (value >> shift) === (network >> shift);
}

const IPV4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([address, prefix]) => [ipv4Value(address), prefix]);

const IPV6_BLOCKED = [
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['3fff::', 20], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
].map(([address, prefix]) => [ipv6Value(address), prefix]);

/**
 * Reject non-public and special-purpose destinations. IPv6 is allowlisted
 * only within global-unicast 2000::/3 after explicit transition/documentation
 * exclusions; IPv4-mapped IPv6 is evaluated as its embedded IPv4 address.
 */
export function isBlockedIp(input) {
  const ip = String(input || '').toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = ipv4Value(ip);
  if (v4 !== null) {
    return IPV4_BLOCKED.some(([network, prefix]) => inCidr(v4, network, prefix, 32));
  }
  const v6 = ipv6Value(ip);
  if (v6 === null) return true;
  if ((v6 >> 32n) === 0xffffn) {
    const mappedV4 = v6 & 0xffffffffn;
    return IPV4_BLOCKED.some(([network, prefix]) => inCidr(mappedV4, network, prefix, 32));
  }
  // Only global-unicast IPv6 is eligible; this excludes unspecified, loopback,
  // unique-local, link-local, multicast, IPv4-compatible and other special ranges.
  if (!inCidr(v6, ipv6Value('2000::'), 3, 128)) return true;
  return IPV6_BLOCKED.some(([network, prefix]) => inCidr(v6, network, prefix, 128));
}

/**
 * DNS preflight is defense in depth only. A worker's network namespace must
 * still force all traffic through the connection-time egress proxy.
 */
export async function publicUrlPreflight(value, resolve = lookup) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid public URL'); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.port && url.port !== '443') {
    throw new Error('Hosted mode requires HTTPS, standard port and no credentials');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') ||
      host.endsWith('.test') || host.endsWith('.invalid') ||
      host.endsWith('.example') || host.endsWith('.onion') ||
      host.endsWith('.home.arpa')) {
    throw new Error('Local or reserved hostnames are not permitted for cloud egress');
  }
  const addresses = isIP(host) ? [{ address: host }] :
    await resolve(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(record => isBlockedIp(record.address))) {
    throw new Error('Private, reserved, or unresolvable destination is prohibited');
  }
  return url.href;
}
