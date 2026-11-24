// Glasses <-> Telegram pairing for glasses that are NOT on this machine (packaged .ehpk app on a
// phone, reaching the backend through a public URL). The glasses show a short code; a linked
// Telegram user sends /pair <code>; the glasses receive a device token they keep in storage.
// Only a hash of each token is stored, so a leaked devices.json cannot be replayed.

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface Device {
  id: string;
  tokenHash: string;
  pairedBy: string;
  createdAt: number;
}

interface PendingCode {
  expires: number;
  onPaired: (token: string, pairedBy: string) => void;
}

const DATA_DIR = new URL('../data/', import.meta.url);
const FILE = new URL('devices.json', DATA_DIR);
export const CODE_TTL_MS = 5 * 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class Pairing {
  private codes = new Map<string, PendingCode>();
  private devices: Device[] = [];

  constructor(private persist = true) {
    if (persist && existsSync(FILE)) {
      try {
        this.devices = JSON.parse(readFileSync(FILE, 'utf8')) as Device[];
      } catch {
        this.devices = [];
      }
    }
  }

  private save() {
    if (!this.persist) return;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(this.devices, null, 2));
  }

  /** New 6-digit code for a waiting device (single use, expires in 5 minutes). */
  createCode(onPaired: PendingCode['onPaired'], now = Date.now()): string {
    for (const [c, p] of this.codes) if (p.expires < now) this.codes.delete(c);
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    while (this.codes.has(code));
    this.codes.set(code, { expires: now + CODE_TTL_MS, onPaired });
    return code;
  }

  /** Called from Telegram /pair <code>. Returns false for unknown or expired codes. */
  complete(code: string, pairedBy: string, now = Date.now()): boolean {
    const clean = code.replace(/\D/g, '');
    const pending = this.codes.get(clean);
    this.codes.delete(clean);
    if (!pending || pending.expires < now) return false;
    const token = randomBytes(32).toString('base64url');
    this.devices.push({ id: randomBytes(4).toString('hex'), tokenHash: sha256(token), pairedBy, createdAt: now });
    this.save();
    pending.onPaired(token, pairedBy);
    return true;
  }

  /** The device for a stored token, or null. */
  verify(token: string): Device | null {
    if (!token) return null;
    const h = sha256(token);
    return this.devices.find((d) => d.tokenHash === h) ?? null;
  }

  list(): Device[] {
    return [...this.devices];
  }

  revokeAll(): number {
    const n = this.devices.length;
    this.devices = [];
    this.save();
    return n;
  }

  cancelCode(code: string) {
    this.codes.delete(code);
  }
}
