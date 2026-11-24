import {
  AudioInputSource,
  OsEventTypeList,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import type { ActionKind, ClientMessage, PositionView, ServerMessage, Snapshot } from '../../shared/protocol.ts';
import {
  confirmCard,
  emptyCard,
  listeningCard,
  MENU,
  menuCard,
  notUnderstoodCard,
  positionCard,
  resultCard,
  statusCard,
  thinkingCard,
  workingCard,
} from './card.ts';

const BACKEND_URL: string = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8787';
const WS_URL = BACKEND_URL.replace(/^http/, 'ws') + '/ws';

const CARD = { id: 1, name: 'card' };

let bridge: EvenAppBridge | null = null;
let glassesReady = false;
let ws: WebSocket | null = null;
let reconnectMs = 1000;
let lastSnapshot: Snapshot | null = null;
let positionIndex = 0;

// UI state machine: card -> menu -> confirm -> working -> result -> card
type Mode =
  | { kind: 'card' }
  | { kind: 'menu'; coin: string; selected: number }
  | { kind: 'confirm'; coin: string; action: ActionKind; expires: number; heard?: string }
  | { kind: 'listening'; started: number }
  | { kind: 'thinking'; requestId: string }
  | { kind: 'notUnderstood'; transcript: string }
  | { kind: 'working'; coin: string; action: ActionKind; requestId: string }
  | { kind: 'result'; ok: boolean; message: string };
let mode: Mode = { kind: 'card' };
const CONFIRM_TIMEOUT_MS = 10_000; // a stale confirm screen must never fire later
let confirmTimer: ReturnType<typeof setTimeout> | undefined;

// Push-to-talk audio buffer (16 kHz mono s16le chunks from the glasses mic).
const MAX_LISTEN_MS = 8_000;
let audioChunks: Uint8Array[] = [];
let listenTicker: ReturnType<typeof setInterval> | undefined;

const mirror = document.getElementById('mirror')!;

// ---------- rendering ----------

async function show(text: string) {
  mirror.textContent = text;
  if (!bridge || !glassesReady) return;
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: CARD.id, containerName: CARD.name, content: text }),
  );
}

function currentPosition(): PositionView | null {
  const snap = lastSnapshot;
  if (!snap || snap.positions.length === 0) return null;
  positionIndex = Math.min(positionIndex, snap.positions.length - 1);
  return snap.positions[positionIndex]!;
}

function positionFor(coin: string): PositionView | null {
  return lastSnapshot?.positions.find((p) => p.coin === coin) ?? null;
}

function setMode(next: Mode) {
  clearTimeout(confirmTimer);
  mode = next;
  if (next.kind === 'confirm') {
    confirmTimer = setTimeout(() => {
      if (mode === next) setMode({ kind: 'card' });
    }, CONFIRM_TIMEOUT_MS);
  } else if (next.kind === 'thinking') {
    confirmTimer = setTimeout(() => {
      if (mode === next) setMode({ kind: 'notUnderstood', transcript: '' });
    }, 20_000);
  } else if (next.kind === 'working') {
    confirmTimer = setTimeout(() => {
      if (mode === next) setMode({ kind: 'result', ok: false, message: 'No reply in 20s. Check the position before retrying.' });
    }, 20_000);
  }
  render();
}

function render() {
  const snap = lastSnapshot;
  switch (mode.kind) {
    case 'card': {
      if (!snap) return;
      const p = currentPosition();
      return void show(p ? positionCard(snap, p, positionIndex) : emptyCard(snap));
    }
    case 'menu': {
      const p = positionFor(mode.coin);
      return void (p ? show(menuCard(p, mode.selected)) : setMode({ kind: 'card' }));
    }
    case 'confirm': {
      const p = positionFor(mode.coin);
      return void (p ? show(confirmCard(p, mode.action, mode.heard)) : setMode({ kind: 'card' }));
    }
    case 'working':
      return void show(workingCard(mode.action, mode.coin));
    case 'result':
      return void show(resultCard(mode.ok, mode.message));
    case 'listening':
      return void show(listeningCard((Date.now() - mode.started) / 1000));
    case 'thinking':
      return void show(thinkingCard());
    case 'notUnderstood':
      return void show(notUnderstoodCard(mode.transcript));
  }
}

// ---------- voice (push-to-talk) ----------

function toBytes(pcm: unknown): Uint8Array {
  if (pcm instanceof Uint8Array) return pcm;
  if (Array.isArray(pcm)) return Uint8Array.from(pcm as number[]);
  if (typeof pcm === 'string') return Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0));
  return new Uint8Array(0);
}

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function startListening() {
  if (!bridge || ws?.readyState !== WebSocket.OPEN || !lastSnapshot?.canTrade) return;
  audioChunks = [];
  const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
  if (!ok) return setMode({ kind: 'result', ok: false, message: 'Microphone unavailable.' });
  setMode({ kind: 'listening', started: Date.now() });
  clearInterval(listenTicker);
  listenTicker = setInterval(() => {
    if (mode.kind !== 'listening') return clearInterval(listenTicker);
    if (Date.now() - mode.started > MAX_LISTEN_MS) void stopListening();
    else render();
  }, 500);
}

async function stopListening() {
  if (mode.kind !== 'listening') return;
  clearInterval(listenTicker);
  await bridge?.audioControl(false).catch(() => false);
  const total = audioChunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Uint8Array(total);
  let off = 0;
  for (const c of audioChunks) (pcm.set(c, off), (off += c.length));
  audioChunks = [];
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  setMode({ kind: 'thinking', requestId });
  sendToServer({
    type: 'voice',
    requestId,
    pcm: base64(pcm),
    screenCoin: currentPosition()?.coin ?? null,
    coins: lastSnapshot?.positions.map((p) => p.coin) ?? [],
  });
}

const renderSnapshot = () => {
  // Live price updates only redraw the screens that show live data.
  if (mode.kind === 'card' || mode.kind === 'menu') render();
};

// ---------- backend connection ----------

function sendToServer(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  void show(statusCard('Connecting to PerpGuard server...'));
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    reconnectMs = 1000;
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as ServerMessage;
    if (msg.type === 'snapshot') {
      lastSnapshot = msg;
      renderSnapshot();
    } else if (msg.type === 'voiceResult') {
      if (mode.kind === 'thinking' && mode.requestId === msg.requestId) {
        const cmd = msg.command;
        if (cmd && positionFor(cmd.coin)) {
          setMode({ kind: 'confirm', coin: cmd.coin, action: cmd.action, expires: Date.now() + CONFIRM_TIMEOUT_MS, heard: msg.transcript });
        } else setMode({ kind: 'notUnderstood', transcript: msg.transcript });
      }
    } else if (msg.type === 'actionResult') {
      if (mode.kind === 'working' && mode.requestId === msg.requestId) {
        setMode({ kind: 'result', ok: msg.ok, message: msg.message });
      }
    } else if (msg.type === 'status' && mode.kind === 'card') {
      void show(statusCard(msg.message));
    }
  };
  ws.onclose = () => {
    ws = null;
    if (mode.kind === 'listening') {
      clearInterval(listenTicker);
      void bridge?.audioControl(false).catch(() => false);
    }
    if (mode.kind === 'working') mode = { kind: 'result', ok: false, message: 'Connection lost. Check the position before retrying.' };
    else mode = { kind: 'card' };
    void show(statusCard('Server offline. Reconnecting...'));
    setTimeout(connect, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, 15000);
  };
}

// ---------- input ----------

function eventTypeOf(event: EvenHubEvent): { type: OsEventTypeList | undefined; isInput: boolean } {
  const src = event.textEvent ?? event.listEvent ?? event.sysEvent;
  return { type: src?.eventType, isInput: Boolean(src) };
}

async function onEvent(event: EvenHubEvent) {
  if (event.audioEvent) {
    if (mode.kind === 'listening') audioChunks.push(toBytes(event.audioEvent.audioPcm));
    return;
  }
  const { type, isInput } = eventTypeOf(event);
  if (!isInput) return; // audio / menu events are handled elsewhere (later)

  const isClick = type === undefined || type === OsEventTypeList.CLICK_EVENT; // CLICK can arrive as undefined
  const scroll =
    type === OsEventTypeList.SCROLL_BOTTOM_EVENT ? 1 : type === OsEventTypeList.SCROLL_TOP_EVENT ? -1 : 0;

  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    // Even Hub review rule: double tap on the root page opens the system exit dialog.
    // Inside sub-screens it acts as "back" instead.
    if (mode.kind === 'card') await bridge?.shutDownPageContainer(1);
    else if (mode.kind === 'listening') {
      clearInterval(listenTicker);
      audioChunks = [];
      await bridge?.audioControl(false).catch(() => false); // cancel: never leave the mic open
      setMode({ kind: 'card' });
    } else if (mode.kind !== 'working') setMode({ kind: 'card' });
    return;
  }
  if (type === OsEventTypeList.LONG_PRESS_EVENT) {
    if (mode.kind === 'card' || mode.kind === 'menu' || mode.kind === 'notUnderstood' || mode.kind === 'result') await startListening();
    return;
  }
  if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) {
    await stopListening();
    return;
  }
  if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    connect(); // Android may have suspended the WebView and dropped the socket
    return;
  }

  switch (mode.kind) {
    case 'card': {
      const n = lastSnapshot?.positions.length ?? 0;
      if (scroll && n > 1) {
        positionIndex = (positionIndex + scroll + n) % n;
        render();
      } else if (isClick) {
        const p = currentPosition();
        if (p && lastSnapshot?.canTrade) setMode({ kind: 'menu', coin: p.coin, selected: 0 });
        else sendToServer({ type: 'refresh' });
      }
      break;
    }
    case 'menu':
      if (scroll) setMode({ ...mode, selected: (mode.selected + scroll + MENU.length) % MENU.length });
      else if (isClick) {
        const action = MENU[mode.selected];
        if (!action) setMode({ kind: 'card' });
        else setMode({ kind: 'confirm', coin: mode.coin, action, expires: Date.now() + CONFIRM_TIMEOUT_MS });
      }
      break;
    case 'confirm':
      if (scroll) setMode({ kind: 'menu', coin: mode.coin, selected: 0 }); // scroll = cancel
      else if (isClick && Date.now() < mode.expires) {
        if (ws?.readyState !== WebSocket.OPEN) {
          setMode({ kind: 'result', ok: false, message: 'Server offline. Nothing was sent.' });
          break;
        }
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { coin, action, heard } = mode; // read before setMode replaces the confirm state
        setMode({ kind: 'working', coin, action, requestId });
        sendToServer({ type: 'action', requestId, action, coin, heard });
      }
      break;
    case 'listening':
      if (isClick) await stopListening(); // fallback if the release event never arrives
      break;
    case 'working':
    case 'thinking':
      break; // ignore input while busy
    case 'result':
    case 'notUnderstood':
      if (isClick) setMode({ kind: 'card' });
      break;
  }
}

// ---------- startup ----------

async function startGlasses(): Promise<void> {
  // Outside the Even App (plain browser) the bridge never appears: fall back to the mirror only.
  const found = await Promise.race([
    waitForEvenAppBridge().then((b) => b),
    new Promise<null>((r) => setTimeout(() => r(null), 3000)),
  ]);
  if (!found) {
    console.info('[perpguard] No Even App bridge: browser preview mode.');
    return;
  }
  bridge = found;

  const page = () => ({
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        xPosition: 8,
        yPosition: 8,
        width: 560,
        height: 272,
        containerID: CARD.id,
        containerName: CARD.name,
        content: statusCard('Starting...'),
        isEventCapture: 1,
      }),
    ],
  });
  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page()));
  glassesReady = result === StartUpPageCreateResult.success;
  if (!glassesReady) {
    // The WebView reloaded while our page still exists on the glasses: rebuild it instead.
    console.warn('[perpguard] createStartUpPageContainer returned', result, '- rebuilding page');
    glassesReady = await bridge.rebuildPageContainer(new RebuildPageContainer(page())).catch(() => false);
    if (!glassesReady) console.error('[perpguard] rebuildPageContainer failed: glasses display unavailable');
  }

  bridge.onEvenHubEvent((e) => void onEvent(e));
}

await startGlasses();
connect();
