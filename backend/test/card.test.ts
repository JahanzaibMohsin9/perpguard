// Glasses card text: only glyphs the G2 display renders, and it fits the 576x288 lens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmCard,
  emptyCard,
  listeningCard,
  menuCard,
  notUnderstoodCard,
  positionCard,
  resultCard,
  safetyBar,
} from '../../glasses/src/card.ts';
import type { PositionView, Snapshot } from '../../shared/protocol.ts';

const ALLOWED_NON_ASCII = new Set([...'●○▲▼▶◀★━─█╭╮╰╯']);
const p: PositionView = {
  coin: 'ETH', side: 'LONG', size: 0.9654, leverage: 25, entryPx: 1681.2,
  markPx: 1678, liqPx: 1636, liqDistancePct: 2.5, unrealizedPnl: -6.83, minutesToLiq: 14.2,
};
const snap: Snapshot = {
  type: 'snapshot', network: 'testnet', address: '0xc1bBF5a49b4F8B7CF0CE9efa1988f25892a654c7',
  accountValue: 958.3, positions: [p], canTrade: true, ts: 0,
};

const cards: Record<string, string> = {
  position: positionCard(snap, p, 0),
  empty: emptyCard({ ...snap, positions: [] }),
  menu: menuCard(p, 2),
  confirm: confirmCard(p, 'close50', 'close half'),
  listening: listeningCard(2.5),
  notUnderstood: notUnderstoodCard('Those 500%'),
  result: resultCard(true, 'Closed 50%: ETH filled 0.4827 @ 1678.2'),
};

test('cards use only glyphs the G2 can render (no emoji)', () => {
  for (const [name, text] of Object.entries(cards)) {
    for (const ch of text) {
      const ok = ch === '\n' || (ch >= ' ' && ch <= '~') || ALLOWED_NON_ASCII.has(ch);
      assert.ok(ok, `${name} card has unsupported glyph ${JSON.stringify(ch)}`);
    }
  }
});

test('cards fit the lens: at most 9 lines', () => {
  for (const [name, text] of Object.entries(cards)) {
    const lines = text.split('\n').length;
    assert.ok(lines <= 9, `${name} card has ${lines} lines`);
  }
});

test('position card shows the risk label and safety bar', () => {
  assert.match(cards.position, /LIQ 2\.5% away {2}▲ DANGER/);
  assert.match(cards.position, /~14 min to liq/);
  assert.equal(safetyBar(2.5), '█' + '─'.repeat(9));
  assert.equal(safetyBar(25), '█'.repeat(10));
});
