import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { ACTION_LABELS, type ActionKind, type ClientMessage, type ServerMessage } from '../../shared/protocol.ts';
import { agentKeyFromEnv, Trader } from './exchange.ts';
import { fetchSnapshot, isAddress, type Network } from './hyperliquid.ts';
import { readFile } from 'node:fs/promises';
import type { FastifyRequest } from 'fastify';
import { Guardian } from './guardian.ts';
import { CODE_TTL_MS, Pairing } from './pairing.ts';
import { TelegramBot } from './telegram.ts';
import { isLocalConnection } from './local.ts';
import { startNgrok, startQuickTunnel } from './tunnel.ts';
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
  guardian?.userActed(coin); // a person is handling it: Guardian stands down
  if (actionBusy) return { ok: false, message: 'Another action is still running.' };
  actionBusy = true;
  try {
    const result = await trader.run(action, coin);
    app.log.info({ action, coin, ok: result.ok, detail: result.detail }, 'action');
    if (!result.ok) return { ok: false, message: result.message };
    return { ok: true, message: result.message + (await receiptExtras(coin)) };
  } catch (err) {
    app.log.error({ err, action }, 'action failed');
    return { ok: false, message: 'Action failed. Check the server log.' };
  } finally {
    actionBusy = false;
    void monitorTick();
  }
}

/** Guardian's own action (same one-at-a-time lock as people's actions). */
async function runGuard(coin: string, fraction: number): Promise<{ ok: boolean; message: string }> {
  if (!trader) return { ok: false, message: 'Trading not linked.' };
  if (actionBusy) return { ok: false, message: 'Another action was running; Guardian skipped.' };
  actionBusy = true;
  try {
    const result = await trader.guard(coin, fraction);
    app.log.info({ guardian: true, coin, ok: result.ok, detail: result.detail }, 'action');
    return result.ok ? { ok: true, message: result.message + (await receiptExtras(coin)) } : result;
  } finally {
    actionBusy = false;
    void monitorTick();
  }
}

/** " · liq now 12.4% away · protected 6.1 s after the alert" for receipts. */
async function receiptExtras(coin: string): Promise<string> {
  let extra = '';
  try {
    if (isAddress(DEFAULT_ADDRESS)) {
      const snap = await fetchSnapshot(NETWORK, DEFAULT_ADDRESS);
      const p = snap.positions.find((x) => x.coin === coin);
      if (!p) extra += '; position closed';
      else if (p.liqDistancePct !== null) extra += `; liq now ${p.liqDistancePct >= 100 ? '>99' : p.liqDistancePct.toFixed(1)}% away`;
    }
  } catch {
    // receipt still goes out without the extra line
  }
  const alertedAt = bot?.lastAlertAt(coin);
  if (alertedAt && Date.now() - alertedAt < 15 * 60_000) {
    extra += `; protected ${((Date.now() - alertedAt) / 1000).toFixed(1)} s after the alert`;
  }
  return extra;
}

// ---------- background monitor + Telegram ----------
let latest: Snapshot | null = null;
let monitorInFlight = false;
async function monitorTick() {
  if (!isAddress(DEFAULT_ADDRESS) || monitorInFlight) return;
  monitorInFlight = true;
  try {
    latest = { ...(await fetchSnapshot(NETWORK, DEFAULT_ADDRESS)), canTrade: Boolean(trader), guardian: guardianInfo() };
    await bot?.onSnapshot(latest);
    guardian?.onSnapshot(latest);
  } catch (err) {
    app.log.warn(`monitor: ${(err as Error).message}`);
  } finally {
    monitorInFlight = false;
  }
}

// ---------- Guardian (opt-in dead man's switch) ----------
const sockets = new Set<WebSocket>();
function broadcastNotice(ok: boolean, title: string, message: string) {
  for (const s of sockets) send(s, { type: 'notice', ok, title, message });
}
const guardian: Guardian | null = trader
  ? new Guardian({
      warnPct: () => bot?.thresholds().warnPct ?? 8,
      dangerPct: () => bot?.thresholds().dangerPct ?? 3,
      act: (coin, fraction) => runGuard(coin, fraction),
      onArmed: (coin, s) => void bot?.guardianArmed(coin, s.graceSec, s.closePct),
      onCancelled: (coin, reason) => void bot?.guardianCancelled(coin, reason),
      onActed: (coin, result) => {
        void bot?.guardianActed(coin, result.ok, result.message);
        broadcastNotice(result.ok, result.ok ? 'GUARDIAN ACTED' : 'GUARDIAN FAILED', result.message);
      },
      log: (m) => app.log.info(m),
    })
  : null;
function guardianInfo(): Snapshot['guardian'] {
  if (!guardian) return undefined;
  const { enabled, graceSec, closePct } = guardian.settings;
  const armed = guardian.armedList().map((a) => ({ coin: a.coin, secondsLeft: Math.max(0, Math.round((a.deadline - Date.now()) / 1000)) }));
  return { enabled, graceSec, closePct, armed };
}

const pairing = new Pairing();

/** Public Mini App URL from the Cloudflare tunnel; applied to the bot's menu button whenever both exist. */
let miniAppUrl: string | null = null;
let bot: TelegramBot | null = null;
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
if (TG_TOKEN) {
  const tg = new TelegramBot(TG_TOKEN, process.env.TELEGRAM_PROXY?.trim() || undefined, {
    getSnapshot: async () => {
      await monitorTick();
      return latest;
    },
    runAction: (action, coin) => runProtective(action, coin),
    pairing: {
      complete: (code, by) => pairing.complete(code, by),
      list: () => pairing.list().map((d) => ({ id: d.id, pairedBy: d.pairedBy, createdAt: d.createdAt })),
      revokeAll: () => pairing.revokeAll(),
    },
    guardian: guardian
      ? {
          settings: () => guardian.settings,
          update: (patch) => guardian.update(patch),
          cancel: (coin) => guardian.cancel(coin, 'cancelled from Telegram'),
        }
      : undefined,
    voiceEnabled: VOICE_ENABLED,
    log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m), error: (o, m) => app.log.error(o, m) },
  });
  // Retry with backoff: Telegram may only be reachable once the VPN/proxy comes up.
  const startBot = async (delayMs = 5000): Promise<void> => {
    try {
      await tg.start();
      bot = tg;
      if (miniAppUrl) await tg.setMiniAppUrl(miniAppUrl).catch((err: Error) => app.log.error(`menu button: ${err.message}`));
    } catch (err) {
      const msg = (err as Error).message;
      if (/unauthorized|401|not found|404/i.test(msg)) return void app.log.error(`Telegram disabled: ${msg} (check TELEGRAM_BOT_TOKEN)`);
      app.log.warn(`Telegram unreachable (${msg}); retrying in ${delayMs / 1000}s`);
      setTimeout(() => void startBot(Math.min(delayMs * 2, 60_000)), delayMs);
    }
  };
  void startBot();
}
setInterval(() => void monitorTick(), Math.max(POLL_MS, 5000));

const ACTIONS = new Set<ActionKind>(Object.keys(ACTION_LABELS) as ActionKind[]);

await app.register(cors, { origin: true });
await app.register(websocket);

app.get('/health', async () => ({ ok: true, network: NETWORK, ts: Date.now() }));

// Telegram Mini App (single static page, no build step).
const MINI_APP = new URL('../public/app.html', import.meta.url);
app.get('/app', async (_req, reply) => {
  reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8');
  return readFile(MINI_APP, 'utf8');
});

function isLocalRequest(req: FastifyRequest): boolean {
  return isLocalConnection(req.socket.remoteAddress, req.headers);
}

function send(socket: WebSocket, msg: ServerMessage) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

app.get('/ws', { websocket: true }, (socket, req) => {
  // Local glasses may trade; remote clients (Mini App via tunnel) must prove a linked Telegram user.
  const local = isLocalRequest(req);
  let authed = local;
  let userName: string | null = null;
  let address = authed && isAddress(DEFAULT_ADDRESS) ? DEFAULT_ADDRESS : '';
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;

  const canTrade = () => Boolean(authed && trader && address.toLowerCase() === trader.master.toLowerCase());
  const sendSession = () =>
    send(socket, { type: 'session', authed, user: userName, master: authed && isAddress(DEFAULT_ADDRESS) ? DEFAULT_ADDRESS : null });

  const poll = async () => {
    if (!address) {
      send(socket, {
        type: 'status',
        level: 'info',
        message: local ? 'No wallet linked yet. Set HL_WATCH_ADDRESS.' : 'Spectator mode: enter an address to watch.',
      });
      return;
    }
    if (inFlight) return;
    inFlight = true;
    try {
      send(socket, { ...(await fetchSnapshot(NETWORK, address)), canTrade: canTrade(), guardian: canTrade() ? guardianInfo() : undefined });
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
    const source = !local ? `Mini App (${userName ?? 'user'})` : heard ? 'glasses voice' : 'glasses tap';
    void bot?.receipt(source, msg.action, msg.coin, result.ok, result.message, heard);
    void poll(); // show the new position state right away
  };

  let voiceBusy = false;
  const runVoice = async (msg: Extract<ClientMessage, { type: 'voice' }>) => {
    const reply = (transcript: string, command: { action: ActionKind; coin: string } | null) =>
      send(socket, { type: 'voiceResult', requestId: msg.requestId, transcript, command });
    if (!VOICE_ENABLED || voiceBusy || !authed) return reply('', null);
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
    } else if (msg.type === 'auth' && typeof msg.deviceToken === 'string' && !local) {
      const device = pairing.verify(msg.deviceToken);
      if (device) {
        authed = true;
        userName = device.pairedBy;
        sockets.add(socket);
        req.log.info(`Paired device ${device.id} connected`);
        if (!address && isAddress(DEFAULT_ADDRESS)) address = DEFAULT_ADDRESS;
      }
      sendSession();
      restart();
    } else if (msg.type === 'pairRequest' && !local && !authed) {
      if (pairCode) pairing.cancelCode(pairCode);
      pairCode = pairing.createCode((token, by) => {
        pairCode = null;
        authed = true;
        userName = by;
        sockets.add(socket);
        if (isAddress(DEFAULT_ADDRESS)) address = DEFAULT_ADDRESS;
        send(socket, { type: 'paired', token, pairedBy: by });
        sendSession();
        restart();
      });
      send(socket, { type: 'pairCode', code: pairCode, botUsername: bot?.username ?? null, expiresInSec: CODE_TTL_MS / 1000 });
    } else if (msg.type === 'auth' && typeof msg.initData === 'string' && !local) {
      const initData = msg.initData;
      void (async () => {
        const user = bot ? await bot.verifyMiniAppUser(initData) : null;
        if (user) {
          authed = true;
          userName = user.name;
          req.log.info(`Mini App user verified: ${user.id}`);
          if (!address && isAddress(DEFAULT_ADDRESS)) address = DEFAULT_ADDRESS;
        }
        sendSession();
        restart();
      })();
    } else if (msg.type === 'action') {
      void runAction(msg);
    } else if (msg.type === 'voice' && typeof msg.pcm === 'string') {
      void runVoice(msg);
    }
  });

  let pairCode: string | null = null;
  if (local || authed) sockets.add(socket);
  socket.on('close', () => {
    clearInterval(timer);
    sockets.delete(socket);
    if (pairCode) pairing.cancelCode(pairCode);
  });
  sendSession();
  restart();
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[perpguard] backend on http://localhost:${PORT} (${NETWORK}, ${trader ? 'trading enabled' : 'read-only'})`);

// Public URLs (opt-in), e.g. TUNNEL=cloudflare,ngrok
//   cloudflare: Mini App (new URL each start; the bot updates its menu button)
//   ngrok:      fixed URL for packaged glasses (NGROK_AUTHTOKEN + NGROK_DOMAIN)
const tunnels = new Set((process.env.TUNNEL ?? '').split(',').map((t) => t.trim().toLowerCase()));
if (tunnels.has('ngrok')) {
  const { NGROK_AUTHTOKEN, NGROK_DOMAIN } = process.env;
  if (!NGROK_AUTHTOKEN || !NGROK_DOMAIN) app.log.error('TUNNEL=ngrok needs NGROK_AUTHTOKEN and NGROK_DOMAIN');
  else {
    // Retry with backoff: the network (or VPN) may come up after the backend.
    const connectNgrok = async (delayMs = 5000): Promise<void> => {
      try {
        const { url } = await startNgrok(PORT, NGROK_AUTHTOKEN, NGROK_DOMAIN);
        app.log.info(`Glasses public URL: ${url}`);
      } catch (err) {
        app.log.warn(`ngrok failed (${(err as Error).message}); retrying in ${delayMs / 1000}s`);
        setTimeout(() => void connectNgrok(Math.min(delayMs * 2, 60_000)), delayMs);
      }
    };
    void connectNgrok();
  }
}
if (tunnels.has('cloudflare')) {
  const connectCloudflare = async (delayMs = 10_000): Promise<void> => {
    try {
      const { url } = await startQuickTunnel(PORT, (m) => app.log.warn(m));
      miniAppUrl = `${url}/app`;
      app.log.info(`Mini App public URL: ${miniAppUrl}`);
      await bot?.setMiniAppUrl(miniAppUrl).catch((err: Error) => app.log.error(`menu button: ${err.message}`));
    } catch (err) {
      app.log.warn(`Cloudflare tunnel failed (${(err as Error).message}); retrying in ${delayMs / 1000}s`);
      setTimeout(() => void connectCloudflare(Math.min(delayMs * 2, 120_000)), delayMs);
    }
  };
  void connectCloudflare();
}
