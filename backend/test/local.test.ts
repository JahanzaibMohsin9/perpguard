// Only direct connections from this PC may trade without pairing; tunnel and LAN traffic may not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalConnection } from '../src/local.ts';

test('loopback without forwarding headers is local', () => {
  assert.equal(isLocalConnection('127.0.0.1', {}), true);
  assert.equal(isLocalConnection('::1', { host: 'localhost:8787' }), true);
  assert.equal(isLocalConnection('::ffff:127.0.0.1', {}), true);
});

test('tunnel traffic (loopback + forwarding headers) is remote', () => {
  assert.equal(isLocalConnection('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), false); // ngrok
  assert.equal(isLocalConnection('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' }), false); // Cloudflare
  assert.equal(isLocalConnection('::1', { 'x-forwarded-proto': 'https' }), false);
  assert.equal(isLocalConnection('127.0.0.1', { forwarded: 'for=203.0.113.9' }), false);
  assert.equal(isLocalConnection('127.0.0.1', { 'x-forwarded-for': '' }), false); // present but empty still counts
});

test('LAN and unknown addresses are remote', () => {
  assert.equal(isLocalConnection('192.168.1.20', {}), false);
  assert.equal(isLocalConnection(undefined, {}), false);
});
