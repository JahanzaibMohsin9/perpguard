import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { ACTION_LABELS, type ActionKind, type ClientMessage, type ServerMessage } from '../../shared/protocol.ts';
import { agentKeyFromEnv, Trader } from './exchange.ts';
import { fetchSnapshot, isAddress, type Network } from './hyperliquid.ts';

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
  const v = await t.verify().catch((err: Error) => ({ ok: false, reason: err.message }));
  if (v.ok) {
    trader = t;
    app.log.info(`Trading enabled: agent ${t.agent.address} for ${DEFAULT_ADDRESS}`);
  } else {
    app.log.warn(`Trading disabled: ${v.reason}`);
  }
}

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
  let actionBusy = false;

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
    if (actionBusy) return reply(false, 'Another action is still running.');
    actionBusy = true;
    try {
      const result = await trader.run(msg.action, msg.coin);
      req.log.info({ action: msg.action, coin: msg.coin, ok: result.ok, detail: result.detail }, 'action');
      reply(result.ok, result.message);
    } catch (err) {
      req.log.error({ err, action: msg.action }, 'action failed');
      reply(false, 'Action failed. Check the server log.');
    } finally {
      actionBusy = false;
      void poll(); // show the new position state right away
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
    }
  });

  socket.on('close', () => clearInterval(timer));
  restart();
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[perpguard] backend on http://localhost:${PORT} (${NETWORK}, ${trader ? 'trading enabled' : 'read-only'})`);
