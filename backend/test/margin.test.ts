// "Add margin": how much USDC moves an isolated position's liquidation price back to a target distance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marginToTarget } from '../src/exchange.ts';

test('matches a real testnet move: +25 USDC took ETH liq from 1672.40 to 1636.12 (0.7032 ETH, max 25x)', () => {
  const mark = 1732.6;
  const targetPct = ((mark - 1636.12) / mark) * 100; // the distance we actually ended at
  const usd = marginToTarget(true, mark, 1672.4, 0.7032, targetPct, 25);
  assert.ok(Math.abs(usd - 25) < 0.1, `expected ~25 USDC, got ${usd}`);
});

test('shorts move liquidation up, and nothing is needed when already far enough', () => {
  // short 1 ETH at 2000, liq 2040 (2% away); target 8% -> liq 2160, needs 120 * (1 + 0.02) USDC
  assert.ok(Math.abs(marginToTarget(false, 2000, 2040, 1, 8, 25) - 122.4) < 1e-9);
  assert.equal(marginToTarget(true, 2000, 1700, 1, 8, 25), 0); // 15% away already
  assert.equal(marginToTarget(false, 2000, 2300, 1, 8, 25), 0);
});
