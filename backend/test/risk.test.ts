// Liquidation distance and alert levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liquidationDistancePct } from '../src/hyperliquid.ts';
import { nextRisk, riskLevel } from '../src/telegram.ts';

test('distance to liquidation for longs and shorts', () => {
  assert.equal(liquidationDistancePct('LONG', 100, 90), 10);
  assert.equal(liquidationDistancePct('SHORT', 100, 110), 10);
  assert.equal(liquidationDistancePct('LONG', 100, 101), 0); // already past: clamp to 0
  assert.equal(liquidationDistancePct('LONG', 100, null), null); // no liquidation price
  assert.equal(liquidationDistancePct('LONG', null, 90), null); // no mark price
});

test('risk levels use the warning and danger thresholds', () => {
  assert.equal(riskLevel(null, 8, 3), 'OK');
  assert.equal(riskLevel(12, 8, 3), 'OK');
  assert.equal(riskLevel(5.4, 8, 3), 'WARNING');
  assert.equal(riskLevel(2.9, 8, 3), 'DANGER');
});

test('hysteresis: escalate at once, step down only 0.5% past the threshold', () => {
  assert.equal(nextRisk('WARNING', 2.9, 8, 3), 'DANGER'); // escalate immediately
  assert.equal(nextRisk('DANGER', 3.1, 8, 3), 'DANGER'); // hovering at 3%: stay, no alert spam
  assert.equal(nextRisk('DANGER', 3.6, 8, 3), 'WARNING'); // clearly back above
  assert.equal(nextRisk('WARNING', 8.2, 8, 3), 'WARNING');
  assert.equal(nextRisk('WARNING', 8.6, 8, 3), 'OK');
  assert.equal(nextRisk(undefined, 2, 8, 3), 'DANGER'); // first sight
});
