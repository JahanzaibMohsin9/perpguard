import {
  OsEventTypeList,
  CreateStartUpPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import type { ClientMessage, ServerMessage, Snapshot } from '../../shared/protocol.ts';
import { emptyCard, positionCard, statusCard } from './card.ts';

const BACKEND_URL: string = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8787';
const WS_URL = BACKEND_URL.replace(/^http/, 'ws') + '/ws';

const CARD = { id: 1, name: 'card' };

let bridge: EvenAppBridge | null = null;
let glassesReady = false;
let ws: WebSocket | null = null;
let reconnectMs = 1000;
let lastSnapshot: Snapshot | null = null;
let positionIndex = 0;

const mirror = document.getElementById('mirror')!;

// ---------- rendering ----------

async function show(text: string) {
  mirror.textContent = text;
  if (!bridge || !glassesReady) return;
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: CARD.id, containerName: CARD.name, content: text }),
  );
}

function renderSnapshot() {
  const snap = lastSnapshot;
  if (!snap) return;
  if (snap.positions.length === 0) return void show(emptyCard(snap));
  positionIndex = Math.min(positionIndex, snap.positions.length - 1);
  void show(positionCard(snap, snap.positions[positionIndex]!, positionIndex));
}

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
    } else {
      void show(statusCard(msg.message));
    }
  };
  ws.onclose = () => {
    ws = null;
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
  const { type, isInput } = eventTypeOf(event);
  if (!isInput) return; // audio / menu events are handled elsewhere (later)

  switch (type) {
    // CLICK_EVENT can arrive as undefined: treat it as a click.
    case undefined:
    case OsEventTypeList.CLICK_EVENT:
      sendToServer({ type: 'refresh' });
      break;
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      if (lastSnapshot && lastSnapshot.positions.length > 1) {
        positionIndex = (positionIndex + 1) % lastSnapshot.positions.length;
        renderSnapshot();
      }
      break;
    case OsEventTypeList.SCROLL_TOP_EVENT:
      if (lastSnapshot && lastSnapshot.positions.length > 1) {
        const n = lastSnapshot.positions.length;
        positionIndex = (positionIndex - 1 + n) % n;
        renderSnapshot();
      }
      break;
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      // Even Hub review rule: double tap on the root page opens the system exit dialog.
      await bridge?.shutDownPageContainer(1);
      break;
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      connect(); // Android may have suspended the WebView and dropped the socket
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

  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
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
    }),
  );
  glassesReady = result === StartUpPageCreateResult.success;
  if (!glassesReady) console.error('[perpguard] createStartUpPageContainer failed:', result);

  bridge.onEvenHubEvent((e) => void onEvent(e));
}

await startGlasses();
connect();
