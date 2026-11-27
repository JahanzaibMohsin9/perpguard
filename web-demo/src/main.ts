// PerpGuard "try it": the real glasses card renderer, the real Hyperliquid read code, and the real voice
// path (Whisper + the fixed phrase grammar) in a browser. Read-only: the confirm step ends in a demo
// receipt instead of an order.

import { fetchSnapshot, info, isAddress, type Network } from '../../backend/src/hyperliquid.ts';
import {
  MENU,
  confirmCard,
  emptyCard,
  listeningCard,
  menuCard,
  notUnderstoodCard,
  positionCard,
  resultCard,
  statusCard,
  thinkingCard,
} from '../../glasses/src/card.ts';
import { parseCommand } from '../../backend/src/grammar.ts';
import { loadModel, startRecording, transcribe } from './voice.ts';
import { ACTION_LABELS, ADD_MARGIN_MAX_USD, ADD_MARGIN_TARGET_PCT, type ActionKind, type Snapshot } from '../../shared/protocol.ts';

const DEMO_ACCOUNT = '0xc1bBF5a49b4F8B7CF0CE9efa1988f25892a654c7'; // PerpGuard's testnet demo account
const POLL_MS = 3000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const lens = $<HTMLPreElement>('lens');
const addrInput = $<HTMLInputElement>('addr');
const netSelect = $<HTMLSelectElement>('net');
const status = $<HTMLDivElement>('status');

type Mode =
  | { kind: 'card' }
  | { kind: 'menu'; coin: string; selected: number }
  | { kind: 'confirm'; coin: string; action: ActionKind; heard?: string }
  | { kind: 'listening'; started: number }
  | { kind: 'thinking' }
  | { kind: 'heard'; text: string }
  | { kind: 'result'; message: string; title?: string };

let network: Network = 'testnet';
let address = DEMO_ACCOUNT;
let snap: Snapshot | null = null;
let index = 0;
let mode: Mode = { kind: 'card' };
let pollTimer: ReturnType<typeof setInterval> | undefined;
let generation = 0; // ignore responses for a previous address
let sample = false; // showing the built-in sample position instead of a live address
let autoSample = !new URLSearchParams(location.search).get('address'); // landing page: show the sample if the demo account is flat

// ---------- rendering ----------

function current() {
  if (!snap || snap.positions.length === 0) return null;
  index = Math.min(index, snap.positions.length - 1);
  return snap.positions[index]!;
}

function render() {
  const p = current();
  switch (mode.kind) {
    case 'card':
      lens.textContent = !snap ? statusCard('Loading...') : p ? positionCard(snap, p, index) : emptyCard(snap);
      break;
    case 'menu': {
      const coin = mode.coin;
      const pos = snap?.positions.find((x) => x.coin === coin);
      lens.textContent = pos ? menuCard(pos, mode.selected) : statusCard('Position closed.');
      break;
    }
    case 'confirm': {
      const coin = mode.coin;
      const pos = snap?.positions.find((x) => x.coin === coin);
      lens.textContent = pos ? confirmCard(pos, mode.action, mode.heard) : statusCard('Position closed.');
      break;
    }
    case 'listening':
      lens.textContent = listeningCard((Date.now() - mode.started) / 1000);
      break;
    case 'thinking':
      lens.textContent = thinkingCard('in your browser');
      break;
    case 'heard':
      lens.textContent = notUnderstoodCard(mode.text);
      break;
    case 'result':
      lens.textContent = resultCard(true, mode.message, mode.title);
      break;
  }
}

function setMode(next: Mode) {
  mode = next;
  render();
}

// ---------- data ----------

async function poll() {
  const gen = generation;
  try {
    const s = await fetchSnapshot(network, address);
    if (gen !== generation) return;
    if (autoSample && s.positions.length === 0) {
      autoSample = false;
      return void showSample();
    }
    autoSample = false;
    snap = { ...s, canTrade: true };
    status.textContent = `Live · ${network} · ${short(address)} · updated ${new Date().toLocaleTimeString()}`
      + (s.positions.length ? '' : ' · No open position here: try "Sample DANGER position" or "Random live trader".');
    if (mode.kind === 'card' || mode.kind === 'menu' || mode.kind === 'confirm') render();
  } catch (err) {
    status.textContent = `Could not reach Hyperliquid (${(err as Error).message}). Retrying...`;
  }
}

function watch(addr: string, net: Network) {
  if (!isAddress(addr)) {
    status.textContent = 'Enter a valid 0x address (42 characters).';
    return;
  }
  address = addr;
  network = net;
  sample = false;
  addrInput.value = addr;
  netSelect.value = net;
  generation++;
  snap = null;
  index = 0;
  setMode({ kind: 'card' });
  const url = new URL(location.href);
  url.searchParams.set('address', addr);
  url.searchParams.set('network', net);
  url.searchParams.delete('sample');
  history.replaceState(null, '', url);
  clearInterval(pollTimer);
  void poll();
  pollTimer = setInterval(poll, POLL_MS);
}

/**
 * A made-up isolated ETH long 2.6% from liquidation at today's testnet ETH price, so there is always
 * something to protect. Nothing here is live or sent; actions change only this sample.
 */
async function showSample() {
  generation++;
  clearInterval(pollTimer);
  sample = true;
  index = 0;
  const mids = await info<Record<string, string>>('testnet', { type: 'allMids' }).catch(() => ({}) as Record<string, string>);
  const mark = Math.round(Number(mids.ETH) || 3000);
  const size = 0.6;
  const entry = Math.round(mark * 1.011);
  snap = {
    type: 'snapshot',
    network: 'testnet',
    address: 'sample',
    accountValue: 850,
    canTrade: true,
    ts: Date.now(),
    positions: [{
      coin: 'ETH', side: 'LONG', size, leverage: 25, entryPx: entry, markPx: mark,
      liqPx: Math.round(mark * (1 - 0.026)), liqDistancePct: 2.6,
      unrealizedPnl: +((mark - entry) * size).toFixed(2), minutesToLiq: 14, isolated: true,
    }],
  };
  const url = new URL(location.href);
  url.searchParams.set('sample', '1');
  history.replaceState(null, '', url);
  status.textContent = 'Sample position (made up, not live). Tap for actions, or hold and say "add margin". Nothing is sent.';
  setMode({ kind: 'card' });
}

/** What the confirm step does to the sample position, so the card shows the effect. */
function applyToSample(action: ActionKind, coin: string): string {
  const p = snap?.positions.find((x) => x.coin === coin);
  if (!snap || !p || p.markPx === null) return 'Position closed.';
  const dir = p.side === 'LONG' ? 1 : -1;
  switch (action) {
    case 'addMargin':
      p.liqPx = Math.round(p.markPx * (1 - (dir * ADD_MARGIN_TARGET_PCT) / 100));
      p.liqDistancePct = ADD_MARGIN_TARGET_PCT;
      p.minutesToLiq = null;
      return `Added margin from free USDC. Liq now ${p.liqPx}, ${ADD_MARGIN_TARGET_PCT}% away. Size unchanged.`;
    case 'close50':
      p.size = +(p.size / 2).toPrecision(6);
      p.unrealizedPnl = +(p.unrealizedPnl / 2).toFixed(2);
      return 'Closed half. Isolated: liq price unchanged, half the margin now at risk. Try Add margin.';
    case 'closeAll':
      snap.positions = snap.positions.filter((x) => x !== p);
      return `Closed the whole ${coin} position.`;
    case 'stopBreakEven':
      return `Stop-loss set at entry ${p.entryPx}. Liq price unchanged.`;
    case 'stop2pct':
      return `Stop-loss set 2% from mark, at ${Math.round(p.markPx * (1 - dir * 0.02))}, before liquidation.`;
  }
}

/** Someone who just traded and holds a position with a liquidation price. */
async function randomTrader(net: Network): Promise<string | null> {
  const seen = new Set<string>();
  for (const coin of ['BTC', 'ETH', 'SOL', 'HYPE']) {
    const trades = await info<Array<{ users?: [string, string] }>>(net, { type: 'recentTrades', coin }).catch(() => []);
    for (const t of trades) for (const u of t.users ?? []) seen.add(u);
    if (seen.size >= 16) break;
  }
  for (const u of [...seen].sort(() => Math.random() - 0.5).slice(0, 16)) {
    const st = await info<{ assetPositions: Array<{ position: { liquidationPx: string | null } }> }>(net, {
      type: 'clearinghouseState',
      user: u,
    }).catch(() => null);
    if (st?.assetPositions.some((a) => a.position.liquidationPx !== null)) return u;
  }
  return null;
}

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

// ---------- input (same flow as the glasses app) ----------

type Input = 'click' | 'up' | 'down' | 'double';

function liveResult(action: ActionKind, coin: string): string {
  return action === 'addMargin'
    ? `Add margin ${coin}: the real app moves free USDC in until liq is ${ADD_MARGIN_TARGET_PCT}% away (max ${ADD_MARGIN_MAX_USD} USDC).`
    : `${ACTION_LABELS[action]} ${coin}: the real app now sends a reduce-only testnet order via your agent wallet.`;
}

function onInput(input: Input) {
  const p = current();
  const scroll = input === 'down' ? 1 : input === 'up' ? -1 : 0;
  if (input === 'double') return setMode({ kind: 'card' });

  switch (mode.kind) {
    case 'card':
      if (scroll && snap && snap.positions.length > 1) {
        index = (index + scroll + snap.positions.length) % snap.positions.length;
        render();
      } else if (input === 'click' && p) setMode({ kind: 'menu', coin: p.coin, selected: 0 });
      break;
    case 'menu':
      if (scroll) setMode({ ...mode, selected: (mode.selected + scroll + MENU.length) % MENU.length });
      else if (input === 'click') {
        const action = MENU[mode.selected];
        setMode(action ? { kind: 'confirm', coin: mode.coin, action } : { kind: 'card' });
      }
      break;
    case 'confirm':
      if (scroll) setMode({ kind: 'menu', coin: mode.coin, selected: 0 });
      else if (input === 'click') {
        setMode(sample
          ? { kind: 'result', title: 'SAMPLE · NOT SENT', message: applyToSample(mode.action, mode.coin) }
          : { kind: 'result', title: 'DEMO ONLY', message: liveResult(mode.action, mode.coin) });
      }
      break;
    case 'result':
    case 'heard':
      if (input === 'click') setMode({ kind: 'card' });
      break;
    case 'listening':
    case 'thinking':
      break;
  }
}

// ---------- voice: hold to talk, real Whisper + the real phrase grammar, all in this browser ----------

let stopRecording: (() => Promise<Float32Array>) | null = null;
let recordingSince = 0;
let autoStop: ReturnType<typeof setTimeout> | undefined;
let starting = false;

function showModelProgress() {
  void loadModel((f) => {
    if (f < 1) status.textContent = `Downloading the speech model, once (about 80 MB): ${Math.round(f * 100)}%`;
  }).then(
    () => {
      if (mode.kind === 'listening' || mode.kind === 'thinking') status.textContent = 'Speech model ready. It runs in your browser: no audio leaves this page.';
    },
    (err) => {
      status.textContent = `Could not load the speech model (${(err as Error).message}).`;
    },
  );
}

async function voiceStart() {
  if (starting || stopRecording) return;
  if (!current() || !['card', 'heard', 'result'].includes(mode.kind)) return;
  starting = true;
  setMode({ kind: 'listening', started: Date.now() });
  const tick = setInterval(() => (mode.kind === 'listening' ? render() : clearInterval(tick)), 250);
  showModelProgress();
  try {
    stopRecording = await startRecording();
    recordingSince = Date.now();
    setMode({ kind: 'listening', started: recordingSince });
    autoStop = setTimeout(() => void voiceEnd(), 5000); // commands are short, like on the glasses
  } catch {
    // No microphone (blocked, or none): show the flow with a scripted phrase instead.
    clearInterval(tick);
    status.textContent = 'No microphone access, so this shows a scripted "close half". Allow the mic to try your own voice.';
    const p = current();
    setTimeout(() => {
      if (p && mode.kind === 'listening') setMode({ kind: 'confirm', coin: p.coin, action: 'close50', heard: 'close half (scripted)' });
    }, 1200);
  } finally {
    starting = false;
  }
}

async function voiceEnd() {
  const stop = stopRecording;
  if (!stop) return;
  stopRecording = null;
  clearTimeout(autoStop);
  setMode({ kind: 'thinking' });
  const audio = await stop();
  let text: string;
  try {
    text = await transcribe(audio);
  } catch (err) {
    status.textContent = `Speech model failed (${(err as Error).message}).`;
    return setMode({ kind: 'heard', text: '' });
  }
  const cmd = parseCommand(text, snap?.positions.map((x) => x.coin) ?? []);
  const target = cmd ? (cmd.coin ? snap?.positions.find((x) => x.coin === cmd.coin) : current()) : null;
  setMode(cmd && target ? { kind: 'confirm', coin: target.coin, action: cmd.action, heard: text } : { kind: 'heard', text });
}

/** Press: start (or, when used as tap-to-toggle, stop). Release after a real hold: stop. */
function voicePress() {
  if (stopRecording) return void voiceEnd();
  void voiceStart();
}
function voiceRelease() {
  // A quick click (or a release while the browser asks for the mic) keeps recording: press again to stop.
  if (!stopRecording || Date.now() - recordingSince < 500) {
    if (mode.kind === 'listening') status.textContent = 'Listening... press Hold again (or Space) to stop.';
    return;
  }
  void voiceEnd();
}

document.querySelectorAll<HTMLButtonElement>('[data-in]').forEach((b) => {
  if (b.dataset.in === 'hold') {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      voicePress();
    });
    b.addEventListener('pointerup', voiceRelease);
    b.addEventListener('contextmenu', (e) => e.preventDefault()); // long press on phones
  } else b.addEventListener('click', () => onInput(b.dataset.in as Input));
});
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (!e.repeat) voicePress();
    return;
  }
  const map: Record<string, Input> = { Enter: 'click', ArrowUp: 'up', ArrowDown: 'down', Escape: 'double' };
  const input = map[e.key];
  if (input) {
    e.preventDefault();
    onInput(input);
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) voiceRelease();
});

$<HTMLButtonElement>('watch').addEventListener('click', () => watch(addrInput.value.trim(), netSelect.value as Network));
addrInput.addEventListener('keydown', (e) => e.key === 'Enter' && watch(addrInput.value.trim(), netSelect.value as Network));
$<HTMLButtonElement>('sample').addEventListener('click', () => void showSample());
const randomBtn = $<HTMLButtonElement>('random');
randomBtn.addEventListener('click', async () => {
  randomBtn.disabled = true;
  status.textContent = 'Looking for someone who just traded...';
  const net = netSelect.value as Network;
  const u = await randomTrader(net);
  randomBtn.disabled = false;
  if (u) watch(u, net);
  else status.textContent = 'No open position found this time. Try again.';
});

// ---------- start ----------
const params = new URLSearchParams(location.search);
const startNet = params.get('network') === 'mainnet' ? 'mainnet' : 'testnet';
if (params.get('sample') === '1') void showSample();
else watch(params.get('address') && isAddress(params.get('address')!) ? params.get('address')! : DEMO_ACCOUNT, startNet);
