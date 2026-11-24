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
  minutesToLiq: number | null; // "at this pace" trend estimate; null = not heading toward liquidation
}

export interface Snapshot {
  type: 'snapshot';
  network: 'testnet' | 'mainnet';
  address: string;
  accountValue: number;
  positions: PositionView[];
  canTrade: boolean; // an approved agent wallet is linked for this address
  ts: number;
}

export interface StatusMessage {
  type: 'status';
  level: 'info' | 'error';
  message: string; // short, glasses-safe text (no emoji)
}

/** Protective-only actions. PerpGuard never opens or increases a position. */
export type ActionKind = 'close50' | 'closeAll' | 'stopBreakEven' | 'stop2pct';

export const ACTION_LABELS: Record<ActionKind, string> = {
  close50: 'Close 50%',
  closeAll: 'Close all',
  stopBreakEven: 'Stop at break-even',
  stop2pct: 'Stop 2% away',
};

export interface ActionResultMessage {
  type: 'actionResult';
  requestId: string;
  ok: boolean;
  message: string; // short, glasses-safe text
}

export interface VoiceResultMessage {
  type: 'voiceResult';
  requestId: string;
  transcript: string;
  command: { action: ActionKind; coin: string } | null; // null = no known phrase heard
}

/** Sent on connect and after auth: what this connection may do. */
export interface SessionMessage {
  type: 'session';
  authed: boolean; // may trade (local glasses, or a verified linked Telegram user)
  user: string | null; // display name of the verified Telegram user
  master: string | null; // the account PerpGuard can protect (only shown to authed sessions)
}

export type ServerMessage = Snapshot | StatusMessage | ActionResultMessage | VoiceResultMessage | SessionMessage;

export type ClientMessage =
  | { type: 'watch'; address: string } // spectator / read-only: watch any address
  | { type: 'refresh' }
  | { type: 'auth'; initData: string } // Telegram Mini App launch data (signed by Telegram)
  | { type: 'action'; requestId: string; action: ActionKind; coin: string; heard?: string } // heard = voice transcript
  // Push-to-talk audio: base64 of 16 kHz mono s16le PCM. screenCoin = position shown on the glasses.
  | { type: 'voice'; requestId: string; pcm: string; screenCoin: string | null; coins: string[] };
