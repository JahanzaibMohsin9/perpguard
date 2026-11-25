// Telegram live card and /history formatting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyHtml, liveHtml, riskLevel, safetyCells } from '../src/telegram.ts';
import type { HistoryEntry, PositionView, Snapshot } from '../../shared/protocol.ts';

const eth: PositionView = {
  coin: 'ETH', side: 'LONG', size: 0.9654, leverage: 25, entryPx: 1681.2,
  markPx: 1678, liqPx: 1636, liqDistancePct: 2.5, unrealizedPnl: -6.83, minutesToLiq: 14.2,
};
const snap: Snapshot = {
  type: 'snapshot', network: 'testnet', address: '0xc1bBF5a49b4F8B7CF0CE9efa1988f25892a654c7',
  accountValue: 958.3, positions: [eth], canTrade: true, ts: 0,
  guardian: { enabled: true, graceSec: 60, closePct: 25, armed: [{ coin: 'ETH', secondsLeft: 42 }] },
};
const risk = (p: PositionView) => riskLevel(p.liqDistancePct, 8, 3);
const at = new Date('2026-11-25T15:42:10Z');

test('safety bar: full when far, one cell when about to be liquidated', () => {
  assert.equal(safetyCells(25), '██████████');
  assert.equal(safetyCells(2.5), '█░░░░░░░░░');
  assert.equal(safetyCells(0.1), '█░░░░░░░░░');
  assert.equal(safetyCells(null), '██████████');
});

test('live card shows risk, pace, Guardian countdown and the update time', () => {
  const html = liveHtml(snap, risk, at);
  assert.match(html, /🔴 <b>ETH LONG 25x<\/b> {2}DANGER/);
  assert.match(html, /2\.5% to liquidation/);
  assert.match(html, /~14 min to liquidation at this pace/);
  assert.match(html, /Guardian ON: <b>closes 25% of ETH in 42 s<\/b>/);
  assert.match(html, /Updated 15:42:10 UTC$/);
  assert.match(liveHtml({ ...snap, positions: [] }, risk, at), /No open positions\. Equity 958\.30 USDC/);
  assert.match(liveHtml(null, risk, at), /Waiting for data/);
});

test('history lists who acted, where, and the order ids', () => {
  const entries: HistoryEntry[] = [
    { ts: Date.parse('2026-11-25T14:02:00Z'), coin: 'ETH', action: 'close50', source: 'Telegram (Ali in Trading Buddies)', ok: true, message: 'Closed 50%', orderIds: [41526234] },
    { ts: Date.parse('2026-11-25T13:55:00Z'), coin: 'ETH', action: 'guardian', source: 'Guardian', ok: true, message: 'Closed 25%', orderIds: [1, 2] },
    { ts: Date.parse('2026-11-25T13:50:00Z'), coin: 'BTC', action: 'stopBreakEven', source: 'glasses <tap>', ok: false, message: 'Not in profit', orderIds: [] },
  ];
  const html = historyHtml(entries, 'https://app.hyperliquid-testnet.xyz/explorer/address/0xabc');
  assert.match(html, /✅ 11-25 14:02 UTC · <b>Close 50% ETH<\/b>\n {4}Telegram \(Ali in Trading Buddies\) · order 41526234/);
  assert.match(html, /🛡 .*Guardian close \+ safety stop ETH.*\n {4}Guardian · orders 1, 2/);
  assert.match(html, /❌ .*Stop at break-even BTC/);
  assert.match(html, /glasses &lt;tap&gt;/); // escaped
  assert.match(html, /explorer\/address\/0xabc/);
  assert.equal(historyHtml([]), '📜 No protective actions yet.');
});
