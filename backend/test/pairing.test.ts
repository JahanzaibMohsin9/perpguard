// Glasses <-> Telegram pairing codes and device tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_TTL_MS, Pairing } from '../src/pairing.ts';

test('a code pairs once and hands the device a token that verifies', () => {
  const p = new Pairing(false);
  let token = '';
  const code = p.createCode((t) => (token = t));
  assert.match(code, /^\d{6}$/);
  assert.equal(p.complete(code, 'Ada'), true);
  assert.ok(token.length >= 40);
  assert.equal(p.verify(token)?.pairedBy, 'Ada');
  assert.equal(p.complete(code, 'Ada'), false); // single use
});

test('spaces in the typed code are fine; wrong or expired codes fail', () => {
  const p = new Pairing(false);
  const code = p.createCode(() => {}, 0);
  assert.equal(p.complete('000000', 'Eve'), false);
  assert.equal(p.complete(`${code.slice(0, 3)} ${code.slice(3)}`, 'Ada', CODE_TTL_MS + 1), false); // expired
  const fresh = p.createCode(() => {});
  assert.equal(p.complete(`${fresh.slice(0, 3)} ${fresh.slice(3)}`, 'Ada'), true);
});

test('unknown tokens fail and revoking removes every device', () => {
  const p = new Pairing(false);
  let token = '';
  p.complete(p.createCode((t) => (token = t)), 'Ada');
  assert.equal(p.verify('not-a-token'), null);
  assert.equal(p.verify(''), null);
  assert.equal(p.revokeAll(), 1);
  assert.equal(p.verify(token), null);
});
