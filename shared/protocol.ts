// Messages exchanged between the G2 app (glasses/) and the backend (backend/) over WebSocket.
// Keep this file dependency-free: both sides import it directly.

export type Side = 'LONG' | 'SHORT';

export interface PositionView {
  coin: string;
  side: Side;
  size: number; // absolute size in coin units
  leverage: number;
  entryPx: number;
  markPx: number | null;
  liqPx: number | null; // null = no liquidation price (e.g. heavily over-collateralised)
  liqDistancePct: number | null; // % the mark must move against us to hit liqPx
  unrealizedPnl: number;
}

export interface Snapshot {
  type: 'snapshot';
  network: 'testnet' | 'mainnet';
  address: string;
  accountValue: number;
  positions: PositionView[];
  ts: number;
}

export interface StatusMessage {
  type: 'status';
  level: 'info' | 'error';
  message: string; // short, glasses-safe text (no emoji)
}

export type ServerMessage = Snapshot | StatusMessage;

export type ClientMessage =
  | { type: 'watch'; address: string } // spectator / read-only: watch any address
  | { type: 'refresh' };
