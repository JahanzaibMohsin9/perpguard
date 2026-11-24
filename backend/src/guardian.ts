// Guardian mode (opt-in): a dead man's switch for liquidation risk.
// When a position enters DANGER, Guardian arms a countdown. If nobody acts on that position before
// it runs out (and it is still in DANGER), Guardian protects it: reduce-only partial close plus a
// stop just before the liquidation price. Any protective action on the coin cancels the countdown.
// At most one Guardian action per coin per cooldown period.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Snapshot } from '../../shared/protocol.ts';
import { nextRisk, type Risk } from './telegram.ts';

export interface GuardianSettings {
  enabled: boolean;
  graceSec: number; // countdown after the DANGER alert
  closePct: number; // share of the position Guardian closes
}

export interface Armed {
  coin: string;
  deadline: number; // ms epoch
}

export interface GuardianDeps {
  warnPct: () => number;
  dangerPct: () => number;
  act: (coin: string, fraction: number) => Promise<{ ok: boolean; message: string }>;
  onArmed: (coin: string, settings: GuardianSettings) => void;
  onCancelled: (coin: string, reason: string) => void;
  onActed: (coin: string, result: { ok: boolean; message: string }) => void;
  log: (msg: string) => void;
}

const DATA_DIR = new URL('../data/', import.meta.url);
const FILE = new URL('guardian.json', DATA_DIR);
const COOLDOWN_MS = 10 * 60_000;
export const DEFAULT_SETTINGS: GuardianSettings = { enabled: false, graceSec: 60, closePct: 25 };

export class Guardian {
  settings: GuardianSettings;
  private level = new Map<string, Risk>();
  private armed = new Map<string, { deadline: number; timer: NodeJS.Timeout }>();
  private lastActed = new Map<string, number>();

  constructor(private deps: GuardianDeps, private persist = true) {
    this.settings = { ...DEFAULT_SETTINGS };
    if (persist && existsSync(FILE)) {
      try {
        this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(FILE, 'utf8')) };
      } catch {
        // keep defaults
      }
    }
  }

  update(patch: Partial<GuardianSettings>) {
    this.settings = { ...this.settings, ...patch };
    this.settings.graceSec = Math.min(600, Math.max(15, Math.round(this.settings.graceSec)));
    this.settings.closePct = Math.min(50, Math.max(10, Math.round(this.settings.closePct)));
    if (!this.settings.enabled) for (const coin of [...this.armed.keys()]) this.cancel(coin, 'Guardian turned off');
    if (this.persist) {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(FILE, JSON.stringify(this.settings, null, 2));
    }
  }

  /** Countdowns currently running (shown on the glasses card and in the Mini App). */
  armedList(): Armed[] {
    return [...this.armed.entries()].map(([coin, a]) => ({ coin, deadline: a.deadline }));
  }

  /** Feed every fresh snapshot of the protected account. */
  onSnapshot(snap: Snapshot) {
    const seen = new Set<string>();
    for (const p of snap.positions) {
      seen.add(p.coin);
      const before = this.level.get(p.coin);
      const now = nextRisk(before, p.liqDistancePct, this.deps.warnPct(), this.deps.dangerPct());
      this.level.set(p.coin, now);
      if (now === 'DANGER' && !this.armed.has(p.coin)) this.maybeArm(p.coin);
      if (now !== 'DANGER' && this.armed.has(p.coin)) this.cancel(p.coin, 'risk dropped below DANGER');
    }
    for (const coin of [...this.armed.keys()]) if (!seen.has(coin)) this.cancel(coin, 'position closed');
    for (const coin of [...this.level.keys()]) if (!seen.has(coin)) this.level.delete(coin);
  }

  /** A person acted on this coin (glasses, voice, Telegram, Mini App): stand down. */
  userActed(coin: string) {
    if (this.armed.has(coin)) this.cancel(coin, 'you acted');
  }

  cancel(coin: string, reason: string) {
    const a = this.armed.get(coin);
    if (!a) return;
    clearTimeout(a.timer);
    this.armed.delete(coin);
    this.deps.log(`Guardian cancelled for ${coin}: ${reason}`);
    this.deps.onCancelled(coin, reason);
  }

  private maybeArm(coin: string) {
    if (!this.settings.enabled) return;
    const last = this.lastActed.get(coin);
    if (last && Date.now() - last < COOLDOWN_MS) return;
    const deadline = Date.now() + this.settings.graceSec * 1000;
    const timer = setTimeout(() => void this.fire(coin), this.settings.graceSec * 1000);
    this.armed.set(coin, { deadline, timer });
    this.deps.log(`Guardian armed for ${coin}: acts in ${this.settings.graceSec} s`);
    this.deps.onArmed(coin, this.settings);
  }

  private async fire(coin: string) {
    if (!this.armed.has(coin)) return;
    this.armed.delete(coin);
    if (!this.settings.enabled || this.level.get(coin) !== 'DANGER') return;
    this.lastActed.set(coin, Date.now());
    let result: { ok: boolean; message: string };
    try {
      result = await this.deps.act(coin, this.settings.closePct / 100);
    } catch (err) {
      result = { ok: false, message: `Guardian failed: ${(err as Error).message}` };
    }
    this.deps.log(`Guardian acted on ${coin}: ${result.message}`);
    this.deps.onActed(coin, result);
  }
}
