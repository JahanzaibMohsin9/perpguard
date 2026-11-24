// "Time to liquidation at this pace" estimate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarkHistory, minutesToLiquidation, slopePerMinute, type Sample } from '../src/pace.ts';

/** Samples every 10 s for `seconds`, starting at `start` and changing `perMinute` each minute. */
function trend(start: number, perMinute: number, seconds = 120): Sample[] {
  const out: Sample[] = [];
  for (let s = 0; s <= seconds; s += 10) out.push({ t: s * 1000, px: start + (perMinute * s) / 60 });
  return out;
}

test('slope is measured in price per minute', () => {
  assert.ok(Math.abs(slopePerMinute(trend(100, -2))! - -2) < 1e-9);
});

test('long falling toward liquidation: minutes = gap / speed', () => {
  // mark ends at 96, falling 2/min, liq at 90 -> 3 minutes
  const s = trend(100, -2);
  assert.ok(Math.abs(minutesToLiquidation(s, 'LONG', 96, 90)! - 3) < 1e-9);
});

test('short rising toward liquidation', () => {
  const s = trend(100, 5);
  assert.ok(Math.abs(minutesToLiquidation(s, 'SHORT', 110, 130)! - 4) < 1e-9);
});

test('no estimate when moving away, flat, or with too little data', () => {
  assert.equal(minutesToLiquidation(trend(100, 2), 'LONG', 104, 90), null); // moving away
  assert.equal(minutesToLiquidation(trend(100, 0), 'LONG', 100, 90), null); // flat
  assert.equal(minutesToLiquidation(trend(100, -2, 20), 'LONG', 99, 90), null); // only 20 s of data
  assert.equal(minutesToLiquidation(trend(100, -2), 'LONG', 96, null), null); // no liq price
});

test('history keeps a 3-minute window, one sample per second, perps only', () => {
  const h = new MarkHistory();
  for (let s = 0; s <= 300; s += 0.5) h.record({ ETH: String(1700 - s), '@107': '1' }, s * 1000);
  const eth = h.samples('ETH');
  assert.ok(eth.length <= 181 && eth.length >= 170);
  assert.ok(eth[eth.length - 1]!.t - eth[0]!.t <= 180_000);
  assert.equal(h.samples('@107').length, 0);
});
