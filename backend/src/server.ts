import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { ACTION_LABELS, type ActionKind, type ClientMessage, type ServerMessage } from '../../shared/protocol.ts';
import { agentKeyFromEnv, Trader } from './exchange.ts';
import { fetchSnapshot, isAddress, type Network } from './hyperliquid.ts';
import { TelegramBot } from './telegram.ts';
import { loadWhisper, parseCommand, transcribe } from './voice.ts';
import type { Snapshot } from '../../shared/protocol.ts';

const PORT = Number(process.env.PORT ?? 8787);
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS ?? 3000));
const NETWORK: Network = process.env.HL_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
const DEFAULT_ADDRESS = (process.env.HL_WATCH_ADDRESS ?? '').trim();

const app = Fastify({ logger: { level: 'info' } });

// ---------- trading (agent wallet) ----------
// Hackathon money-safety rule: trading is only ever enabled on testnet.
let trader: Trader | null = null;
const agentKey = agentKeyFromEnv();
if (NETWORK !== 'testnet') {
  app.log.warn('HL_NETWORK is not testnet: trading disabled, read-only.');
} else if (!agentKey) {
  app.log.info('No HL_AGENT_KEY set: read-only mode.');
} else if (!isAddress(DEFAULT_ADDRESS)) {
  app.log.warn('HL_AGENT_KEY set but HL_WATCH_ADDRESS (the master account) is missing: read-only mode.');
} else {
  const t = new Trader(NETWORK, DEFAULT_ADDRESS, agentKey);
  // Network errors are retried; a definite "not approved" answer is final.
  const tryVerify = async (attempt: number): Promise<void> => {
    try {
      const v = await t.verify();
      if (v.ok) {
        trader = t;
        app.log.info(`Trading enabled: agent ${t.agent.address} for ${DEFAULT_ADDRESS}`);
      } else app.log.warn(`Trading disabled: ${v.reason}`);
    } catch (err) {
      const wait = Math.min(30_000, 2_000 * attempt);
      app.log.warn(`Agent check failed (${(err as Error).message}); retrying in ${wait / 1000}s`);
      setTimeout(() => void tryVerify(attempt + 1), wait);
    }
  };
  await tryVerify(1);
}

// Warm up Whisper in the background so the first voice command is fast.
const VOICE_ENABLED = process.env.VOICE !== 'off';
if (VOICE_ENABLED) {
  const t0 = Date.now();
  loadWhisper().then(
    () => app.log.info(`Whisper ready in ${Date.now() - t0} ms`),
    (err) => app.log.error({ err }, 'Whisper failed to load: voice disabled'),
  );
}
const MAX_VOICE_BYTES = 16_000 * 2 * 10; // 10 s of 16 kHz s16le

// ---------- protective actions (shared by glasses and Telegram; one at a time) ----------
let actionBusy = false;
async function runProtective(action: ActionKind, coin: string): Promise<{ ok: boolean; message: string }> {
  if (!trader) return { ok: false, message: 'Trading not linked for this wallet.' };
  if (actionBusy) return { ok: false, message: 'Another action is still running.' };
  actionBusy = true;
  try {
    const result = await trader.run(action, coin);
    app.log.info({ action, coin, ok: result.ok, detail: result.detail }, 'action');
    return { ok: result.ok, message: result.message };
  } catch (err) {
    app.log.error({ err, action }, 'action failed');
    return { ok: false, message: 'Action failed. Check the server log.' };
  } finally {
    actionBusy = false;
    void monitorTick();
  }
}

// ---------- background monitor + Telegram ----------
let latest: Snapshot | null = null;
let monitorInFlight = false;
async function monitorTick() {
  if (!isAddress(DEFAULT_ADDRESS) || monitorInFlight) return;
  monitorInFlight = true;
  try {
    latest = { ...(await fetchSnapshot(NETWORK, DEFAULT_ADDRESS)), canTrade: Boolean(trader) };
    await bot?.onSnapshot(latest);
  } catch (err) {
    app.log.warn(`monitor: ${(err as Error).message}`);
  } finally {
    monitorInFlight = false;
  }
}

let bot: TelegramBot | null = null;
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
if (TG_TOKEN) {
  const tg = new TelegramBot(TG_TOKEN, process.env.TELEGRAM_PROXY?.trim() || undefined, {
    getSnapshot: async () => {
      await monitorTick();
      return latest;
    },
    runAction: (action, coin) => runProtective(action, coin),
    voiceEnabled: VOICE_ENABLED,
    log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m), error: (o, m) => app.log.error(o, m) },
  });
  tg.start().then(
    () => (bot = tg),
    (err: Error) => app.log.error(`Telegram disabled: ${err.message}`),
  );
}
setInterval(() => void monitorTick(), Math.max(POLL_MS, 5000));

const ACTIONS = new Set<ActionKind>(Object.keys(ACTION_LABELS) as ActionKind[]);

await app.register(cors, { origin: true });
await app.register(websocket);

app.get('/health', async () => ({ ok: true, network: NETWORK, trading: Boolean(trader), ts: Date.now() }));

function send(socket: WebSocket, msg: ServerMessage) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

app.get('/ws', { websocket: true }, (socket, req) => {
  let address = isAddress(DEFAULT_ADDRESS) ? DEFAULT_ADDRESS : '';
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;

  const canTrade = () => Boolean(trader && address.toLowerCase() === trader.master.toLowerCase());

  const poll = async () => {
    if (!address) {
      send(socket, { type: 'status', level: 'info', message: 'No wallet linked yet. Set HL_WATCH_ADDRESS.' });
      return;
    }
    if (inFlight) return;
    inFlight = true;
    try {
      send(socket, { ...(await fetchSnapshot(NETWORK, address)), canTrade: canTrade() });
    } catch (err) {
      req.log.warn({ err }, 'snapshot failed');
      send(socket, { type: 'status', level: 'error', message: 'Hyperliquid unreachable. Retrying.' });
    } finally {
      inFlight = false;
    }
  };

  const restart = () => {
    clearInterval(timer);
    void poll();
    timer = setInterval(poll, POLL_MS);
  };

  const runAction = async (msg: Extract<ClientMessage, { type: 'action' }>) => {
    const reply = (ok: boolean, message: string) =>
      send(socket, { type: 'actionResult', requestId: msg.requestId, ok, message });
    if (!trader || !canTrade()) return reply(false, 'Trading not linked for this wallet.');
    if (!ACTIONS.has(msg.action) || !/^[A-Z0-9]{1,12}$/.test(msg.coin)) return reply(false, 'Invalid action.');
    const result = await runProtective(msg.action, msg.coin);
    reply(result.ok, result.message);
    const heard = typeof msg.heard === 'string' && msg.heard ? msg.heard.slice(0, 80) : undefined;
    void bot?.receipt(heard ? 'glasses voice' : 'glasses tap', msg.action, msg.coin, result.ok, result.message, heard);
    void poll(); // show the new position state right away
  };

  let voiceBusy = false;
  const runVoice = async (msg: Extract<ClientMessage, { type: 'voice' }>) => {
    const reply = (transcript: string, command: { action: ActionKind; coin: string } | null) =>
      send(socket, { type: 'voiceResult', requestId: msg.requestId, transcript, command });
    if (!VOICE_ENABLED || voiceBusy) return reply('', null);
    voiceBusy = true;
    try {
      const pcm = Buffer.from(msg.pcm, 'base64').subarray(0, MAX_VOICE_BYTES);
      const t0 = Date.now();
      const transcript = await transcribe(pcm);
      const coins = (msg.coins ?? []).filter((c) => /^[A-Z0-9]{1,12}$/.test(c));
      const parsed = parseCommand(transcript, coins);
      const coin = parsed?.coin ?? msg.screenCoin;
      req.log.info({ transcript, parsed, ms: Date.now() - t0 }, 'voice');
      reply(transcript, parsed && coin ? { action: parsed.action, coin } : null);
    } catch (err) {
      req.log.error({ err }, 'voice failed');
      reply('', null);
    } finally {
      voiceBusy = false;
    }
  };

  socket.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'watch' && isAddress(msg.address)) {
      address = msg.address;
      restart();
    } else if (msg.type === 'refresh') {
      void poll();
    } else if (msg.type === 'action') {
      void runAction(msg);
    } else if (msg.type === 'voice' && typeof msg.pcm === 'string') {
      void runVoice(msg);
    }
  });

  socket.on('close', () => clearInterval(timer));
  restart();
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[perpguard] backend on http://localhost:${PORT} (${NETWORK}, ${trader ? 'trading enabled' : 'read-only'})`);
