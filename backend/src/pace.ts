// "Time to liquidation at this pace": turns recent mark-price movement into a minutes estimate.
// It is a trend extrapolation, not a prediction: it only reports a number while price is moving
// TOWARD the liquidation price, and says nothing when the trend is flat or moving away.

import type { Side } from '../../shared/protocol.ts';

export interface Sample {
  t: number; // ms
  px: number;
}

const WINDOW_MS = 3 * 60_000; // look at the last 3 minutes
const MIN_SPAN_MS = 45_000; // need at least 45 s of data
const MAX_MINUTES = 999;

/** Least-squares slope of price over time, in price units per minute. */
export function slopePerMinute(samples: Sample[]): number | null {
  if (samples.length < 3) return null;
  const t0 = samples[0]!.t;
  const xs = samples.map((s) => (s.t - t0) / 60_000);
  const ys = samples.map((s) => s.px);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

/** Minutes until mark reaches liq if the recent trend continues; null if not heading there. */
export function minutesToLiquidation(samples: Sample[], side: Side, markPx: number | null, liqPx: number | null): number | null {
  if (!markPx || !liqPx || samples.length < 3) return null;
  if (samples[samples.length - 1]!.t - samples[0]!.t < MIN_SPAN_MS) return null;
  const slope = slopePerMinute(samples);
  if (slope === null) return null;
  const towardLiq = side === 'LONG' ? -slope : slope; // price units per minute moving toward liq
  const gap = side === 'LONG' ? markPx - liqPx : liqPx - markPx;
  if (gap <= 0) return 0;
  if (towardLiq <= 0) return null; // flat or moving away
  return Math.min(MAX_MINUTES, gap / towardLiq);
}

/** Rolling per-coin mark history, fed by every allMids fetch. */
export class MarkHistory {
  private byCoin = new Map<string, Sample[]>();

  record(mids: Record<string, string>, now = Date.now()) {
    for (const [coin, px] of Object.entries(mids)) {
      if (coin.startsWith('@')) continue; // spot pairs
      const value = Number(px);
      if (!Number.isFinite(value)) continue;
      const list = this.byCoin.get(coin) ?? [];
      const last = list[list.length - 1];
      if (last && now - last.t < 1_000) continue; // at most one sample per second
      list.push({ t: now, px: value });
      while (list.length && now - list[0]!.t > WINDOW_MS) list.shift();
      this.byCoin.set(coin, list);
    }
  }

  samples(coin: string): Sample[] {
    return this.byCoin.get(coin) ?? [];
  }
}

export const markHistory = new MarkHistory();
