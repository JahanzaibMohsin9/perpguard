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
  guardian?: { enabled: boolean; graceSec: number; closePct: number; armed: Array<{ coin: string; secondsLeft: number }> };
  /** Liquidation distance (%) over the last ~30 min per coin, oldest first (protected account only). */
  trend?: Record<string, number[]>;
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

/** Something happened without a request from this client (e.g. Guardian acted). */
export interface NoticeMessage {
  type: 'notice';
  ok: boolean;
  title: string; // short, glasses-safe
  message: string; // short, glasses-safe
}

/** Pairing for remote glasses: show the code, then store the token. */
export interface PairCodeMessage {
  type: 'pairCode';
  code: string;
  botUsername: string | null;
  expiresInSec: number;
}
export interface PairedMessage {
  type: 'paired';
  token: string;
  pairedBy: string;
}

/** One protective action in the audit trail. */
export interface HistoryEntry {
  ts: number;
  coin: string;
  action: ActionKind | 'guardian';
  source: string; // "glasses tap", "Telegram (Ali)", "Guardian", ...
  ok: boolean;
  message: string;
  orderIds: number[]; // Hyperliquid order ids, checkable with the orderStatus info call
}

/** Recent protective actions, newest first (sent to authed clients on connect and after each action). */
export interface HistoryMessage {
  type: 'history';
  entries: HistoryEntry[];
}

export type ServerMessage =
  | PairCodeMessage
  | PairedMessage
  | Snapshot
  | StatusMessage
  | ActionResultMessage
  | VoiceResultMessage
  | SessionMessage
  | NoticeMessage
  | HistoryMessage;

export type ClientMessage =
  | { type: 'watch'; address: string } // spectator / read-only: watch any address
  | { type: 'refresh' }
  | { type: 'auth'; initData?: string; deviceToken?: string } // Mini App launch data, or a paired device's token
  | { type: 'pairRequest' } // remote glasses ask for a pairing code
  | { type: 'action'; requestId: string; action: ActionKind; coin: string; heard?: string } // heard = voice transcript
  | { type: 'guardian'; enabled: boolean } // turn Guardian on or off (authed clients that can trade)
  // Push-to-talk audio: base64 of 16 kHz mono s16le PCM. screenCoin = position shown on the glasses.
  | { type: 'voice'; requestId: string; pcm: string; screenCoin: string | null; coins: string[] };
