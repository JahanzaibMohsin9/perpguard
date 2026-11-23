// Pure text rendering for the 576x288 glasses card.
// Only glyphs known to render on G2: ● ○ ▲ ▼ ▶ ◀ ★ ━ ─ █ ╭╮╰╯ (emoji are silently dropped).

import type { PositionView, Snapshot } from '../../shared/protocol.ts';

const BAR_CELLS = 10;
const BAR_FULL_AT_PCT = 20; // 20%+ away from liquidation = full safety bar

function fmtPx(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '-';
  const digits = n >= 1000 ? 0 : n >= 1 ? 2 : 4;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtSigned(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toFixed(2)}`;
}

export function safetyBar(distancePct: number | null): string {
  if (distancePct === null) return '█'.repeat(BAR_CELLS);
  const filled = Math.round(Math.min(1, distancePct / BAR_FULL_AT_PCT) * BAR_CELLS);
  return '█'.repeat(filled) + '─'.repeat(BAR_CELLS - filled);
}

function riskLabel(distancePct: number | null): string {
  if (distancePct === null) return 'SAFE';
  if (distancePct < 3) return '▲ DANGER';
  if (distancePct < 8) return '▲ WARNING';
  return 'OK';
}

export function positionCard(snap: Snapshot, p: PositionView, index: number): string {
  const dist =
    p.liqDistancePct === null ? 'no liq price'
    : p.liqDistancePct >= 100 ? '>99% away'
    : `${p.liqDistancePct.toFixed(1)}% away`;
  const pager = snap.positions.length > 1 ? `  ${index + 1}/${snap.positions.length}` : '';
  return [
    `PERPGUARD  ● LIVE  ${snap.network}${pager}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `${p.coin} ${p.side} ${p.leverage}x   size ${p.size}`,
    `PnL ${fmtSigned(p.unrealizedPnl)} USDC`,
    `Mark ${fmtPx(p.markPx)}   Liq ${fmtPx(p.liqPx)}`,
    `LIQ ${dist}  ${riskLabel(p.liqDistancePct)}`,
    safetyBar(p.liqDistancePct),
    '',
    snap.positions.length > 1 ? '> tap refresh  scroll next  2x exit' : '> tap refresh   2x tap exit',
  ].join('\n');
}

export function emptyCard(snap: Snapshot): string {
  return [
    `PERPGUARD  ○ ${snap.network}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'No open positions.',
    `Account ${fmtSigned(snap.accountValue)} USDC`,
    `Wallet ${snap.address.slice(0, 6)}...${snap.address.slice(-4)}`,
    '',
    '> tap refresh   2x tap exit',
  ].join('\n');
}

export function statusCard(message: string): string {
  return ['PERPGUARD', '━━━━━━━━━━━━━━━━━━━━━━━━━━', message, '', '> 2x tap exit'].join('\n');
}
