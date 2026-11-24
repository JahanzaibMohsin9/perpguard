// Telegram Mini App initData verification (decides who may trade from the Mini App).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { checkInitData } from '../src/telegram.ts';

const TOKEN = '123456:TEST-token-for-unit-tests';
const NOW = 1_800_000_000;

/** Builds initData exactly like Telegram does. */
function sign(fields: Record<string, string>, token = TOKEN): string {
  const dataCheck = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dataCheck).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const user = JSON.stringify({ id: 42, first_name: 'Ada' });

test('valid launch data returns the user', () => {
  assert.deepEqual(checkInitData(sign({ auth_date: String(NOW - 60), user }), TOKEN, NOW), { id: 42, name: 'Ada' });
});

test('tampered, foreign-bot or stale launch data is rejected', () => {
  const good = sign({ auth_date: String(NOW - 60), user });
  assert.equal(checkInitData(good.replace('42', '43'), TOKEN, NOW), null); // tampered user id
  assert.equal(checkInitData(sign({ auth_date: String(NOW - 60), user }, '999:other-bot'), TOKEN, NOW), null);
  assert.equal(checkInitData(sign({ auth_date: String(NOW - 25 * 3600), user }), TOKEN, NOW), null); // older than 24 h
  assert.equal(checkInitData('user=x&hash=deadbeef', TOKEN, NOW), null);
  assert.equal(checkInitData('', TOKEN, NOW), null);
});
