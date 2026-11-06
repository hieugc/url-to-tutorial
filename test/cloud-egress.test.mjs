import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, publicUrlPreflight } from '../src/cloud-egress.mjs';

test('Cloud preflight blocks private IPv4, metadata endpoints and local IPv6', () => {
  for (const ip of [
    '127.0.0.1', '10.0.0.1', '172.18.0.4', '192.168.1.2',
    '169.254.169.254', '100.64.1.2', '0.0.0.0', '192.0.2.10',
    '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1',
  ]) assert.equal(isBlockedIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
    assert.equal(isBlockedIp(ip), false, ip);
});

test('Cloud preflight rejects untrusted schemes, DNS returns and unsafe hostnames', async () => {
  const privateDNS = async () => [{ address: '169.254.169.254' }];
  for (const url of [
    'http://example.com', 'https://localhost/', 'https://private.local/',
    'https://user:pass@example.com', 'https://example.com:444/',
  ]) {
    await assert.rejects(publicUrlPreflight(url, privateDNS));
  }
  await assert.rejects(publicUrlPreflight('https://example.com', privateDNS), /Private/);
  const safeDNS = async () => [{ address: '8.8.8.8' }];
  assert.equal(await publicUrlPreflight('https://example.com/pricing', safeDNS),
    'https://example.com/pricing');
});
