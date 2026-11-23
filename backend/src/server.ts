import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../../shared/protocol.ts';
import { fetchSnapshot, isAddress, type Network } from './hyperliquid.ts';

const PORT = Number(process.env.PORT ?? 8787);
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS ?? 3000));
const NETWORK: Network = process.env.HL_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
const DEFAULT_ADDRESS = (process.env.HL_WATCH_ADDRESS ?? '').trim();

if (NETWORK !== 'testnet') {
  // Hackathon money-safety rule: demos must use testnet.
  console.warn('[perpguard] WARNING: HL_NETWORK is not testnet. Read-only only.');
}

const app = Fastify({ logger: { level: 'info' } });
await app.register(cors, { origin: true });
await app.register(websocket);

app.get('/health', async () => ({ ok: true, network: NETWORK, ts: Date.now() }));

function send(socket: WebSocket, msg: ServerMessage) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

app.get('/ws', { websocket: true }, (socket, req) => {
  let address = isAddress(DEFAULT_ADDRESS) ? DEFAULT_ADDRESS : '';
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;

  const poll = async () => {
    if (!address) {
      send(socket, { type: 'status', level: 'info', message: 'No wallet linked yet. Set HL_WATCH_ADDRESS.' });
      return;
    }
    if (inFlight) return;
    inFlight = true;
    try {
      send(socket, await fetchSnapshot(NETWORK, address));
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
    }
  });

  socket.on('close', () => clearInterval(timer));
  restart();
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[perpguard] backend on http://localhost:${PORT} (${NETWORK})`);
