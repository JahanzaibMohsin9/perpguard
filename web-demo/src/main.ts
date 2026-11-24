// PerpGuard "try it": the real glasses card renderer + the real Hyperliquid read code, in a browser.
// Read-only: the confirm step ends in a demo receipt instead of an order.

import { fetchSnapshot, info, isAddress, type Network } from '../../backend/src/hyperliquid.ts';
import {
  MENU,
  confirmCard,
  emptyCard,
  listeningCard,
  menuCard,
  positionCard,
  resultCard,
  statusCard,
} from '../../glasses/src/card.ts';
import { ACTION_LABELS, type ActionKind, type Snapshot } from '../../shared/protocol.ts';

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
  | { kind: 'result'; message: string; title?: string };

let network: Network = 'testnet';
let address = DEMO_ACCOUNT;
let snap: Snapshot | null = null;
let index = 0;
let mode: Mode = { kind: 'card' };
let pollTimer: ReturnType<typeof setInterval> | undefined;
let generation = 0; // ignore responses for a previous address

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
    snap = { ...s, canTrade: true };
    status.textContent = `Live · ${network} · ${short(address)} · updated ${new Date().toLocaleTimeString()}`;
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
  addrInput.value = addr;
  netSelect.value = net;
  generation++;
  snap = null;
  index = 0;
  setMode({ kind: 'card' });
  const url = new URL(location.href);
  url.searchParams.set('address', addr);
  url.searchParams.set('network', net);
  history.replaceState(null, '', url);
  clearInterval(pollTimer);
  void poll();
  pollTimer = setInterval(poll, POLL_MS);
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

type Input = 'click' | 'up' | 'down' | 'hold' | 'double';

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
      else if (input === 'hold' && p) {
        // Simulated voice: the real app records the glasses mic and transcribes it with local Whisper.
        setMode({ kind: 'listening', started: Date.now() });
        const tick = setInterval(() => (mode.kind === 'listening' ? render() : clearInterval(tick)), 250);
        setTimeout(() => {
          clearInterval(tick);
          if (mode.kind === 'listening') setMode({ kind: 'confirm', coin: p.coin, action: 'close50', heard: 'close half (demo)' });
        }, 1800);
      }
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
        setMode({
          kind: 'result',
          title: 'DEMO ONLY',
          message: `${ACTION_LABELS[mode.action]} ${mode.coin}: the real app now sends a reduce-only testnet order via your agent wallet.`,
        });
      }
      break;
    case 'result':
      if (input === 'click') setMode({ kind: 'card' });
      break;
    case 'listening':
      break;
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-in]').forEach((b) =>
  b.addEventListener('click', () => onInput(b.dataset.in as Input)),
);
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const map: Record<string, Input> = { Enter: 'click', ArrowUp: 'up', ArrowDown: 'down', ' ': 'hold', Escape: 'double' };
  const input = map[e.key];
  if (input) {
    e.preventDefault();
    onInput(input);
  }
});

$<HTMLButtonElement>('watch').addEventListener('click', () => watch(addrInput.value.trim(), netSelect.value as Network));
addrInput.addEventListener('keydown', (e) => e.key === 'Enter' && watch(addrInput.value.trim(), netSelect.value as Network));
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
watch(params.get('address') && isAddress(params.get('address')!) ? params.get('address')! : DEMO_ACCOUNT, startNet);
