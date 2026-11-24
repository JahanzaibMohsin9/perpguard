// Pure text rendering for the 576x288 glasses card.
// Only glyphs known to render on G2: ● ○ ▲ ▼ ▶ ◀ ★ ━ ─ █ ╭╮╰╯ (emoji are silently dropped).

import { ACTION_LABELS, type ActionKind, type PositionView, type Snapshot } from '../../shared/protocol.ts';

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

/** "~14 min to liq" while price trends toward liquidation (no such glyph as an approx sign on G2). */
function pace(minutes: number | null): string {
  if (minutes === null) return '';
  if (minutes < 1) return '<1 min to liq';
  if (minutes < 90) return `~${Math.round(minutes)} min to liq`;
  return `~${(minutes / 60).toFixed(1)} h to liq`;
}

/** "★ GUARDIAN acts in 42s" while a countdown runs for this coin. */
function guardianLine(snap: Snapshot, coin: string): string {
  const g = snap.guardian;
  const armed = g?.armed.find((a) => a.coin === coin);
  if (armed) return `★ GUARDIAN closes ${g!.closePct}% in ${armed.secondsLeft}s`;
  return g?.enabled ? '○ guardian on' : '';
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
    `${safetyBar(p.liqDistancePct)}  ${pace(p.minutesToLiq)}`,
    guardianLine(snap, p.coin),
    hints(snap),
  ].join('\n');
}

function hints(snap: Snapshot): string {
  if (!snap.canTrade) return snap.positions.length > 1 ? '> tap refresh  scroll next  2x exit' : '> tap refresh   2x tap exit';
  return '> tap actions  hold speak  2x exit';
}

const RULE = '━━━━━━━━━━━━━━━━━━━━━━━━━━';

/** Menu entries in display order. null = "Back". */
export const MENU: Array<ActionKind | null> = ['close50', 'closeAll', 'stopBreakEven', 'stop2pct', null];

export function menuCard(p: PositionView, selected: number): string {
  return [
    `PERPGUARD  ▶ ACTIONS  ${p.coin} ${p.side}`,
    RULE,
    ...MENU.map((k, i) => `${i === selected ? '▶' : ' '} ${k ? ACTION_LABELS[k] : 'Back'}`),
    '',
    '> scroll move   tap choose',
  ].join('\n');
}

export function confirmCard(p: PositionView, kind: ActionKind, heard?: string): string {
  const detail: Record<ActionKind, string> = {
    close50: `Sell half: ${+(p.size / 2).toPrecision(6)} of ${p.size} ${p.coin}`,
    closeAll: `Exit the whole ${p.size} ${p.coin}`,
    stopBreakEven: `Stop-loss at entry ${fmtPx(p.entryPx)}`,
    stop2pct: `Stop-loss 2% from mark ${fmtPx(p.markPx)}`,
  };
  if (p.side === 'SHORT') {
    detail.close50 = detail.close50.replace('Sell', 'Buy back');
  }
  return [
    `PERPGUARD  ▲ CONFIRM`,
    RULE,
    `${ACTION_LABELS[kind]}  ${p.coin} ${p.side} ${p.leverage}x`,
    detail[kind],
    heard ? `Heard: "${heard.slice(0, 26)}"` : 'Testnet order, reduce-only.',
    '',
    '> tap = YES    scroll = cancel',
  ].join('\n');
}

export function workingCard(kind: ActionKind, coin: string): string {
  return ['PERPGUARD  ○ SENDING', RULE, `${ACTION_LABELS[kind]}  ${coin}`, 'Signing with agent wallet...'].join('\n');
}

export function resultCard(ok: boolean, message: string, title?: string): string {
  return [
    title ? `PERPGUARD  ${ok ? '★' : '▲'} ${title}` : ok ? 'PERPGUARD  ★ DONE' : 'PERPGUARD  ▲ FAILED',
    RULE,
    ...wrap(message, 30, 5),
    '',
    '> tap back',
  ].join('\n');
}

function wrap(text: string, width: number, maxLines = 4): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && (line + ' ' + word).length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.slice(0, maxLines);
}

export function listeningCard(seconds: number): string {
  return [
    'PERPGUARD  ● LISTENING',
    RULE,
    'Say a command, then release:',
    '  "close half"   "close all"',
    '  "break even"   "two percent stop"',
    '',
    `${'█'.repeat(Math.min(10, Math.ceil(seconds)))}${'─'.repeat(Math.max(0, 10 - Math.ceil(seconds)))}  ${seconds.toFixed(1)}s`,
  ].join('\n');
}

export function thinkingCard(): string {
  return ['PERPGUARD  ○ HEARING', RULE, 'Transcribing on your PC...'].join('\n');
}

export function notUnderstoodCard(transcript: string): string {
  return [
    'PERPGUARD  ▲ NOT A COMMAND',
    RULE,
    transcript ? `Heard: "${transcript.slice(0, 26)}"` : 'Heard nothing.',
    'Try: close half / close all /',
    '     break even / two percent stop',
    '',
    '> tap back   hold to retry',
  ].join('\n');
}

/** Shown on glasses that reach the server remotely and are not paired yet. */
export function pairingCard(code: string, botUsername: string | null, minutesLeft: number): string {
  return [
    'PERPGUARD  ● PAIR THIS DEVICE',
    RULE,
    'On Telegram, send this to',
    botUsername ? `@${botUsername}:` : 'the PerpGuard bot:',
    `  /pair ${code.slice(0, 3)} ${code.slice(3)}`,
    `Code expires in ${Math.max(1, Math.ceil(minutesLeft))} min.`,
    '',
    '> tap new code   2x tap exit',
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
