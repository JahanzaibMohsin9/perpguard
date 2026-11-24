// Guardian mode: arms on DANGER, acts only if nobody responds, stands down otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Guardian } from '../src/guardian.ts';
import type { PositionView, Snapshot } from '../../shared/protocol.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function snap(distance: number | null, coin = 'ETH'): Snapshot {
  const p: PositionView = {
    coin, side: 'LONG', size: 1, leverage: 25, entryPx: 100, markPx: 100, liqPx: 98,
    liqDistancePct: distance, unrealizedPnl: 0, minutesToLiq: null,
  };
  return { type: 'snapshot', network: 'testnet', address: '0x0', accountValue: 1000, positions: distance === null ? [] : [p], canTrade: true, ts: 0 };
}

function setup(enabled = true) {
  const events: string[] = [];
  const acted: Array<[string, number]> = [];
  const g = new Guardian(
    {
      warnPct: () => 8,
      dangerPct: () => 3,
      act: async (coin, fraction) => {
        acted.push([coin, fraction]);
        return { ok: true, message: 'closed' };
      },
      onArmed: (coin) => events.push(`armed ${coin}`),
      onCancelled: (coin, reason) => events.push(`cancelled ${coin}: ${reason}`),
      onActed: (coin) => events.push(`acted ${coin}`),
      log: () => {},
    },
    false, // do not touch backend/data in tests
  );
  g.settings = { enabled, graceSec: 0.05, closePct: 25 }; // 50 ms countdown for tests
  return { g, events, acted };
}

test('off by default: DANGER does nothing', async () => {
  const { g, events, acted } = setup(false);
  g.onSnapshot(snap(2));
  await wait(120);
  assert.deepEqual(events, []);
  assert.deepEqual(acted, []);
});

test('no response: Guardian acts once with the configured fraction', async () => {
  const { g, events, acted } = setup();
  g.onSnapshot(snap(5)); // WARNING: nothing
  g.onSnapshot(snap(2)); // DANGER: arm
  assert.equal(g.armedList().length, 1);
  await wait(120);
  assert.deepEqual(acted, [['ETH', 0.25]]);
  assert.deepEqual(events, ['armed ETH', 'acted ETH']);
  g.onSnapshot(snap(2)); // still DANGER, but inside the cooldown: no second action
  await wait(120);
  assert.equal(acted.length, 1);
});

test('a person acting cancels the countdown', async () => {
  const { g, events, acted } = setup();
  g.onSnapshot(snap(2));
  g.userActed('ETH');
  await wait(120);
  assert.deepEqual(acted, []);
  assert.deepEqual(events, ['armed ETH', 'cancelled ETH: you acted']);
});

test('risk improving or the position closing cancels the countdown', async () => {
  const a = setup();
  a.g.onSnapshot(snap(2));
  a.g.onSnapshot(snap(4)); // 0.5% past the 3% threshold (hysteresis) -> WARNING
  await wait(120);
  assert.deepEqual(a.acted, []);
  assert.match(a.events[1]!, /risk dropped/);

  const b = setup();
  b.g.onSnapshot(snap(2));
  b.g.onSnapshot(snap(null)); // position gone
  await wait(120);
  assert.deepEqual(b.acted, []);
  assert.match(b.events[1]!, /position closed/);
});

test('settings are clamped to safe ranges', () => {
  const { g } = setup();
  g.update({ graceSec: 1, closePct: 90 });
  assert.equal(g.settings.graceSec, 15);
  assert.equal(g.settings.closePct, 50);
});
