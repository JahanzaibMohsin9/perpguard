// Read-only Hyperliquid access via the public /info endpoint (no keys needed).
// Order placement (agent wallet + signing) lives in exchange.ts.

import type { PositionView, Side, Snapshot } from '../../shared/protocol.ts';
import { markHistory, minutesToLiquidation } from './pace.ts';

export type Network = 'testnet' | 'mainnet';

export const API_URL: Record<Network, string> = {
  testnet: 'https://api.hyperliquid-testnet.xyz',
  mainnet: 'https://api.hyperliquid.xyz',
};

export async function info<T>(network: Network, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL[network]}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Hyperliquid /info ${res.status}`);
  return (await res.json()) as T;
}

// Subset of the clearinghouseState response we use.
interface ClearinghouseState {
  marginSummary: { accountValue: string };
  assetPositions: Array<{
    position: {
      coin: string;
      szi: string; // signed size: + long, - short
      entryPx: string;
      liquidationPx: string | null;
      unrealizedPnl: string;
      leverage: { type: string; value: number };
    };
  }>;
}

interface SpotState {
  balances: Array<{ coin: string; total: string; hold: string }>;
}

/** % the mark must move AGAINST the position to reach the liquidation price (null if unknown). */
export function liquidationDistancePct(side: Side, markPx: number | null, liqPx: number | null): number | null {
  if (!markPx || !liqPx || liqPx <= 0) return null;
  const move = side === 'LONG' ? markPx - liqPx : liqPx - markPx;
  return Math.max(0, (move / markPx) * 100);
}

export function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export async function fetchSnapshot(network: Network, address: string): Promise<Omit<Snapshot, 'canTrade'>> {
  const [state, mids, spot] = await Promise.all([
    info<ClearinghouseState>(network, { type: 'clearinghouseState', user: address }),
    info<Record<string, string>>(network, { type: 'allMids' }),
    info<SpotState>(network, { type: 'spotClearinghouseState', user: address }),
  ]);
  markHistory.record(mids);
  // Unified accounts keep collateral as spot USDC; free spot USDC counts toward equity.
  const usdc = spot.balances.find((b) => b.coin === 'USDC');
  const freeSpotUsdc = usdc ? Math.max(0, Number(usdc.total) - Number(usdc.hold)) : 0;

  const positions: PositionView[] = state.assetPositions
    .map(({ position: p }) => {
      const szi = Number(p.szi);
      const side: Side = szi >= 0 ? 'LONG' : 'SHORT';
      const markPx = mids[p.coin] !== undefined ? Number(mids[p.coin]) : null;
      const liqPx = p.liquidationPx !== null ? Number(p.liquidationPx) : null;
      const liqDistancePct = liquidationDistancePct(side, markPx, liqPx);
      return {
        coin: p.coin,
        side,
        size: Math.abs(szi),
        leverage: p.leverage.value,
        entryPx: Number(p.entryPx),
        markPx,
        liqPx,
        liqDistancePct,
        unrealizedPnl: Number(p.unrealizedPnl),
        minutesToLiq: minutesToLiquidation(markHistory.samples(p.coin), side, markPx, liqPx),
      };
    })
    .filter((p) => p.size > 0)
    // Riskiest first: smallest distance to liquidation on top.
    .sort((a, b) => (a.liqDistancePct ?? Infinity) - (b.liqDistancePct ?? Infinity));

  return {
    type: 'snapshot',
    network,
    address,
    accountValue: Number(state.marginSummary.accountValue) + freeSpotUsdc,
    positions,
    ts: Date.now(),
  };
}
