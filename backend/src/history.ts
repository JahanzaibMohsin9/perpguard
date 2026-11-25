// Audit trail of every protective action (who, from where, result, Hyperliquid order ids),
// and a short liquidation-distance trend per coin for the Mini App chart.
// The point: an agent key that can trade is only trustworthy if everything it did is visible.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { HistoryEntry } from '../../shared/protocol.ts';

export type { HistoryEntry };

const DATA_DIR = new URL('../data/', import.meta.url);
const HISTORY_FILE = new URL('history.json', DATA_DIR);

export class ActionHistory {
  private entries: HistoryEntry[] = [];

  /** `persist = false` keeps everything in memory (tests). */
  constructor(
    private persist = true,
    private max = 200,
  ) {
    if (persist && existsSync(HISTORY_FILE)) {
      try {
        this.entries = (JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) as HistoryEntry[]).slice(-max);
      } catch {
        this.entries = [];
      }
    }
  }

  add(entry: HistoryEntry) {
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    if (this.persist) {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(HISTORY_FILE, JSON.stringify(this.entries, null, 1));
    }
  }

  /** Newest first. */
  recent(n = 10): HistoryEntry[] {
    return this.entries.slice(-n).reverse();
  }
}

/** Every order id ("oid") found anywhere in an exchange response (filled, resting or trigger orders). */
export function orderIds(detail: unknown): number[] {
  const found = new Set<number>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'oid' && typeof x === 'number') found.add(x);
      else walk(x, depth + 1);
    }
  };
  walk(detail, 0);
  return [...found];
}

/**
 * Liquidation distance over the last `windowMs`, one sample per `stepMs` per coin.
 * Fed by the background monitor; sent to the Mini App for its trend chart.
 */
export class DistanceTrend {
  private samples = new Map<string, Array<{ t: number; d: number }>>();

  constructor(
    private windowMs = 30 * 60_000,
    private stepMs = 10_000,
  ) {}

  add(coin: string, distancePct: number | null, now = Date.now()) {
    if (distancePct === null || !Number.isFinite(distancePct)) return;
    const list = this.samples.get(coin) ?? [];
    const last = list[list.length - 1];
    if (last && now - last.t < this.stepMs) last.d = distancePct; // keep the newest value in this step
    else list.push({ t: now, d: distancePct });
    while (list.length && now - list[0]!.t > this.windowMs) list.shift();
    this.samples.set(coin, list);
  }

  /** Drop coins that no longer have a position. */
  keepOnly(coins: string[]) {
    for (const c of this.samples.keys()) if (!coins.includes(c)) this.samples.delete(c);
  }

  /** coin -> distances, oldest first, rounded to 0.01%. */
  snapshot(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const [coin, list] of this.samples) out[coin] = list.map((s) => Math.round(s.d * 100) / 100);
    return out;
  }
}
