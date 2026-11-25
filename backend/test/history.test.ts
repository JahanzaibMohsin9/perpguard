// Action audit trail and the liquidation-distance trend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionHistory, DistanceTrend, orderIds } from '../src/history.ts';

test('orderIds finds filled, resting and trigger order ids in exchange responses', () => {
  const res = {
    status: 'ok',
    response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.24', avgPx: '1665.4', oid: 3112 } }, { resting: { oid: 3113 } }, 'waitingForTrigger'] } },
  };
  assert.deepEqual(orderIds(res), [3112, 3113]);
  assert.deepEqual(orderIds([res, { response: { data: { statuses: [{ resting: { oid: 3113 } }] } } }]), [3112, 3113]); // deduped
  assert.deepEqual(orderIds(undefined), []);
  assert.deepEqual(orderIds({ error: 'Rejected' }), []);
});

test('history keeps the newest entries, newest first', () => {
  const h = new ActionHistory(false, 3);
  for (let i = 1; i <= 5; i++) {
    h.add({ ts: i, coin: 'ETH', action: 'close50', source: 'glasses tap', ok: true, message: `#${i}`, orderIds: [i] });
  }
  assert.deepEqual(h.recent(10).map((e) => e.message), ['#5', '#4', '#3']);
  assert.deepEqual(h.recent(1).map((e) => e.message), ['#5']);
});

test('distance trend: one sample per step, rolling window, dropped coins', () => {
  const t = new DistanceTrend(60_000, 10_000);
  t.add('ETH', 5.0, 0);
  t.add('ETH', 4.8, 5_000); // same step: replaces the value
  t.add('ETH', 4.5, 10_000);
  t.add('ETH', null, 15_000); // no liquidation price: ignored
  t.add('BTC', 20.123, 10_000);
  assert.deepEqual(t.snapshot(), { ETH: [4.8, 4.5], BTC: [20.12] });
  t.add('ETH', 4.0, 65_000); // the first sample falls out of the 60 s window
  assert.deepEqual(t.snapshot().ETH, [4.5, 4.0]);
  t.keepOnly(['ETH']);
  assert.deepEqual(Object.keys(t.snapshot()), ['ETH']);
});
