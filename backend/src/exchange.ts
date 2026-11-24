// Protective-only order placement on Hyperliquid, signed by an AGENT (API) wallet.
// An agent wallet can place/cancel orders for its master account but can never withdraw funds.
//
// Signing follows the official Python SDK (hyperliquid/utils/signing.py):
//   connectionId = keccak(msgpack(action) | nonce u64 BE | 0x00 (no vault))
//   EIP-712 "Agent" { source: 'a' mainnet | 'b' testnet, connectionId } on domain Exchange/1/1337/0x0.

import { encode } from '@msgpack/msgpack';
import { concat, keccak256, parseSignature, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { ActionKind } from '../../shared/protocol.ts';
import { API_URL, info, type Network } from './hyperliquid.ts';

const SLIPPAGE = 0.05; // aggressive IOC limit = market order with a 5% price cap
const STOP_PCT = 0.02; // "2% stop": stop 2% beyond the current mark, against the position

// ---------- signing ----------

/** keccak(msgpack(action) | nonce u64 BE | 0x00 = no vault). Exported for tests. */
export function actionHash(action: unknown, nonce: number): Hex {
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce));
  return keccak256(concat([encode(action), nonceBytes, new Uint8Array([0])]));
}

/** EIP-712 "phantom agent" payload that Hyperliquid expects for L1 actions. Exported for tests. */
export function l1TypedData(network: Network, action: unknown, nonce: number) {
  return {
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent',
    message: { source: network === 'mainnet' ? 'a' : 'b', connectionId: actionHash(action, nonce) },
  } as const;
}

async function signL1(agent: PrivateKeyAccount, network: Network, action: unknown, nonce: number) {
  const sig = await agent.signTypedData(l1TypedData(network, action, nonce));
  const { r, s, v, yParity } = parseSignature(sig);
  return { r, s, v: v !== undefined ? Number(v) : yParity + 27 };
}

let lastNonce = 0;
function nextNonce(): number {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return lastNonce;
}

interface ExchangeResponse {
  status: 'ok' | 'err';
  response: string | { type: string; data?: { statuses?: Array<Record<string, any> | string> } };
}

export async function exchange(agent: PrivateKeyAccount, network: Network, action: unknown): Promise<ExchangeResponse> {
  const nonce = nextNonce();
  const signature = await signL1(agent, network, action, nonce);
  const res = await fetch(`${API_URL[network]}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature, vaultAddress: null }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid /exchange ${res.status}: ${await res.text()}`);
  return (await res.json()) as ExchangeResponse;
}

// ---------- number formatting (matches SDK float_to_wire + price rules) ----------

export function toWire(x: number): string {
  const s = x.toFixed(8).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** Perp prices: max 5 significant figures and max (6 - szDecimals) decimals. */
export function roundPx(px: number, szDecimals: number): number {
  return Number(Number(px.toPrecision(5)).toFixed(Math.max(0, 6 - szDecimals)));
}

export function roundSz(sz: number, szDecimals: number): number {
  return Number(sz.toFixed(szDecimals));
}

// ---------- market data ----------

interface AssetMeta {
  index: number;
  szDecimals: number;
}

let metaCache: { network: Network; byName: Map<string, AssetMeta> } | null = null;

export async function assetMeta(network: Network, coin: string): Promise<AssetMeta> {
  if (!metaCache || metaCache.network !== network) {
    const meta = await info<{ universe: Array<{ name: string; szDecimals: number }> }>(network, { type: 'meta' });
    metaCache = { network, byName: new Map(meta.universe.map((u, index) => [u.name, { index, szDecimals: u.szDecimals }])) };
  }
  const m = metaCache.byName.get(coin);
  if (!m) throw new Error(`Unknown coin ${coin}`);
  return m;
}

interface LivePosition {
  coin: string;
  szi: number;
  entryPx: number;
}

async function livePosition(network: Network, user: string, coin: string): Promise<LivePosition | null> {
  const state = await info<{ assetPositions: Array<{ position: { coin: string; szi: string; entryPx: string } }> }>(
    network,
    { type: 'clearinghouseState', user },
  );
  const p = state.assetPositions.find((a) => a.position.coin === coin)?.position;
  if (!p || Number(p.szi) === 0) return null;
  return { coin, szi: Number(p.szi), entryPx: Number(p.entryPx) };
}

export async function markPx(network: Network, coin: string): Promise<number> {
  const mids = await info<Record<string, string>>(network, { type: 'allMids' });
  const px = Number(mids[coin]);
  if (!Number.isFinite(px) || px <= 0) throw new Error(`No price for ${coin}`);
  return px;
}

// ---------- actions ----------

export interface ActionResult {
  ok: boolean;
  message: string; // short, glasses-safe
  detail?: unknown; // raw exchange response for logs
}

function firstStatus(r: ExchangeResponse): { ok: boolean; text: string } {
  if (r.status !== 'ok' || typeof r.response === 'string') return { ok: false, text: String(r.response) };
  const st = r.response.data?.statuses?.[0];
  if (!st) return { ok: true, text: 'ok' };
  if (typeof st === 'string') return { ok: true, text: st };
  if (st.error) return { ok: false, text: String(st.error) };
  if (st.filled) return { ok: true, text: `filled ${st.filled.totalSz} @ ${st.filled.avgPx}` };
  if (st.resting) return { ok: true, text: `order placed` };
  return { ok: true, text: JSON.stringify(st) };
}

/** Cancel this coin's existing reduce-only stop-losses so stops never stack up. */
async function cancelExistingStops(agent: PrivateKeyAccount, network: Network, user: string, coin: string, asset: number) {
  const orders = await info<Array<{ coin: string; oid: number; isTrigger: boolean; reduceOnly: boolean; orderType: string }>>(
    network,
    { type: 'frontendOpenOrders', user },
  );
  const stops = orders.filter((o) => o.coin === coin && o.isTrigger && o.reduceOnly && /stop/i.test(o.orderType));
  if (stops.length === 0) return 0;
  await exchange(agent, network, { type: 'cancel', cancels: stops.map((o) => ({ a: asset, o: o.oid })) });
  return stops.length;
}

export class Trader {
  readonly agent: PrivateKeyAccount;

  constructor(
    readonly network: Network,
    readonly master: string,
    agentKey: Hex,
  ) {
    this.agent = privateKeyToAccount(agentKey);
  }

  /** Confirms on-chain that this key is an approved agent of `master`. */
  async verify(): Promise<{ ok: boolean; reason?: string }> {
    const role = await info<{ role: string; data?: { user?: string } }>(this.network, { type: 'userRole', user: this.agent.address });
    if (role.role !== 'agent') return { ok: false, reason: `agent key not approved (role: ${role.role})` };
    if (role.data?.user?.toLowerCase() !== this.master.toLowerCase())
      return { ok: false, reason: `agent belongs to ${role.data?.user}, not ${this.master}` };
    return { ok: true };
  }

  async run(kind: ActionKind, coin: string): Promise<ActionResult> {
    const pos = await livePosition(this.network, this.master, coin);
    if (!pos) return { ok: false, message: `No open ${coin} position.` };
    const { index: a, szDecimals } = await assetMeta(this.network, coin);
    const isLong = pos.szi > 0;
    const absSz = Math.abs(pos.szi);
    const mark = await markPx(this.network, coin);

    if (kind === 'close50' || kind === 'closeAll') {
      let sz = kind === 'closeAll' ? absSz : roundSz(absSz / 2, szDecimals);
      if (sz <= 0) sz = absSz; // position too small to halve
      const px = roundPx(isLong ? mark * (1 - SLIPPAGE) : mark * (1 + SLIPPAGE), szDecimals);
      const action = {
        type: 'order',
        orders: [{ a, b: !isLong, p: toWire(px), s: toWire(sz), r: true, t: { limit: { tif: 'Ioc' } } }],
        grouping: 'na',
      };
      const res = await exchange(this.agent, this.network, action);
      const st = firstStatus(res);
      const what = kind === 'closeAll' ? 'Closed all' : 'Closed 50%';
      return { ok: st.ok, message: st.ok ? `${what}: ${coin} ${st.text}` : `Rejected: ${st.text}`, detail: res };
    }

    // Stop-loss (reduce-only, market trigger) for the full position.
    let trigger: number;
    if (kind === 'stopBreakEven') {
      trigger = pos.entryPx;
      const inProfit = isLong ? mark > trigger : mark < trigger;
      if (!inProfit) return { ok: false, message: 'Not in profit: a break-even stop would fire now.' };
    } else {
      trigger = isLong ? mark * (1 - STOP_PCT) : mark * (1 + STOP_PCT);
    }
    trigger = roundPx(trigger, szDecimals);
    const limit = roundPx(isLong ? trigger * (1 - SLIPPAGE) : trigger * (1 + SLIPPAGE), szDecimals);
    const cancelled = await cancelExistingStops(this.agent, this.network, this.master, coin, a);
    const action = {
      type: 'order',
      orders: [
        {
          a,
          b: !isLong,
          p: toWire(limit),
          s: toWire(absSz),
          r: true,
          t: { trigger: { isMarket: true, triggerPx: toWire(trigger), tpsl: 'sl' } },
        },
      ],
      grouping: 'na',
    };
    const res = await exchange(this.agent, this.network, action);
    const st = firstStatus(res);
    const label = kind === 'stopBreakEven' ? 'Break-even stop' : '2% stop';
    const replaced = cancelled ? ' (replaced old stop)' : '';
    return {
      ok: st.ok,
      message: st.ok ? `${label} set at ${toWire(trigger)}${replaced}` : `Rejected: ${st.text}`,
      detail: res,
    };
  }

  /**
   * Guardian action (reduce-only, two steps):
   *  1. close `fraction` of the position, and
   *  2. make sure a stop sits between mark and liquidation (at `stopShare` of the gap above liq),
   *     so the position exits before the exchange liquidates it. An existing tighter stop is kept.
   */
  async guard(coin: string, fraction: number, stopShare = 0.3): Promise<ActionResult> {
    const state = await info<{ assetPositions: Array<{ position: { coin: string; szi: string; liquidationPx: string | null } }> }>(
      this.network,
      { type: 'clearinghouseState', user: this.master },
    );
    const p = state.assetPositions.find((x) => x.position.coin === coin)?.position;
    if (!p || Number(p.szi) === 0) return { ok: false, message: `No open ${coin} position.` };
    const { index: a, szDecimals } = await assetMeta(this.network, coin);
    const isLong = Number(p.szi) > 0;
    const absSz = Math.abs(Number(p.szi));
    const mark = await markPx(this.network, coin);
    const parts: string[] = [];

    // 1. partial close
    let sz = roundSz(absSz * fraction, szDecimals);
    if (sz <= 0) sz = absSz;
    const px = roundPx(isLong ? mark * (1 - SLIPPAGE) : mark * (1 + SLIPPAGE), szDecimals);
    const closeRes = await exchange(this.agent, this.network, {
      type: 'order',
      orders: [{ a, b: !isLong, p: toWire(px), s: toWire(sz), r: true, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    });
    const closed = firstStatus(closeRes);
    if (!closed.ok) return { ok: false, message: `Rejected: ${closed.text}`, detail: closeRes };
    parts.push(`Closed ${Math.round(fraction * 100)}%: ${coin} ${closed.text}`);

    // 2. stop before liquidation (for the remaining size)
    const liq = p.liquidationPx !== null ? Number(p.liquidationPx) : null;
    const remaining = roundSz(absSz - sz, szDecimals);
    if (liq && liq > 0 && remaining > 0) {
      const trigger = roundPx(isLong ? liq + (mark - liq) * stopShare : liq - (liq - mark) * stopShare, szDecimals);
      const orders = await info<Array<{ coin: string; isTrigger: boolean; reduceOnly: boolean; orderType: string; triggerPx: string }>>(
        this.network,
        { type: 'frontendOpenOrders', user: this.master },
      );
      const tighter = orders.some(
        (o) => o.coin === coin && o.isTrigger && o.reduceOnly && /stop/i.test(o.orderType) &&
          (isLong ? Number(o.triggerPx) >= trigger : Number(o.triggerPx) <= trigger),
      );
      if (tighter) {
        parts.push('existing stop kept');
      } else {
        await cancelExistingStops(this.agent, this.network, this.master, coin, a);
        const limit = roundPx(isLong ? trigger * (1 - SLIPPAGE) : trigger * (1 + SLIPPAGE), szDecimals);
        const stopRes = await exchange(this.agent, this.network, {
          type: 'order',
          orders: [{
            a, b: !isLong, p: toWire(limit), s: toWire(remaining), r: true,
            t: { trigger: { isMarket: true, triggerPx: toWire(trigger), tpsl: 'sl' } },
          }],
          grouping: 'na',
        });
        const st = firstStatus(stopRes);
        parts.push(st.ok ? `safety stop at ${toWire(trigger)} (before liq ${toWire(roundPx(liq, szDecimals))})` : `stop rejected: ${st.text}`);
      }
    }
    return { ok: true, message: parts.join(' · '), detail: closeRes };
  }
}

export function agentKeyFromEnv(): Hex | null {
  const k = (process.env.HL_AGENT_KEY ?? '').trim();
  return /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : null;
}
