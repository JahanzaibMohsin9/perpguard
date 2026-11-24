// DEV TOOL (testnet only), not part of the product: set up demo positions for the PerpGuard video.
// PerpGuard itself never opens or increases positions; this script exists so the demo can show
// a position that is genuinely close to liquidation (isolated margin), which the glasses then protect.
//
// Usage (from backend/, uses HL_AGENT_KEY + HL_WATCH_ADDRESS from .env):
//   npx tsx --env-file=.env scripts/demo-position.ts open ETH 20 300   -> isolated 20x long, ~$300 notional
//   npx tsx --env-file=.env scripts/demo-position.ts leverage ETH 25   -> change isolated leverage
//   npx tsx --env-file=.env scripts/demo-position.ts margin ETH -3     -> remove $3 isolated margin (riskier)
//   npx tsx --env-file=.env scripts/demo-position.ts margin ETH 5      -> add $5 margin (safer)

import { agentKeyFromEnv, assetMeta, exchange, markPx, roundPx, roundSz, toWire, Trader } from '../src/exchange.ts';

const NETWORK = 'testnet' as const; // hard-coded on purpose
const master = (process.env.HL_WATCH_ADDRESS ?? '').trim();
const key = agentKeyFromEnv();
if (!key || !master) throw new Error('Set HL_AGENT_KEY and HL_WATCH_ADDRESS in backend/.env');
const trader = new Trader(NETWORK, master, key);
const v = await trader.verify();
if (!v.ok) throw new Error(v.reason);

const [cmd, coin = 'ETH', arg1, arg2] = process.argv.slice(2);
const { index: a, szDecimals } = await assetMeta(NETWORK, coin);

if (cmd === 'open') {
  const leverage = Number(arg1 ?? 20);
  const notional = Number(arg2 ?? 300);
  const lev = await exchange(trader.agent, NETWORK, { type: 'updateLeverage', asset: a, isCross: false, leverage });
  console.log('leverage:', JSON.stringify(lev));
  const mark = await markPx(NETWORK, coin);
  const sz = roundSz(notional / mark, szDecimals);
  const px = roundPx(mark * 1.05, szDecimals);
  const res = await exchange(trader.agent, NETWORK, {
    type: 'order',
    orders: [{ a, b: true, p: toWire(px), s: toWire(sz), r: false, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
  });
  console.log('open:', JSON.stringify(res));
} else if (cmd === 'leverage') {
  const leverage = Number(arg1 ?? 25);
  const res = await exchange(trader.agent, NETWORK, { type: 'updateLeverage', asset: a, isCross: false, leverage });
  console.log('leverage:', JSON.stringify(res));
} else if (cmd === 'margin') {
  const usd = Number(arg1);
  if (!Number.isFinite(usd) || usd === 0) throw new Error('margin needs a non-zero USD amount');
  const res = await exchange(trader.agent, NETWORK, {
    type: 'updateIsolatedMargin',
    asset: a,
    isBuy: true,
    ntli: Math.round(usd * 1e6),
  });
  console.log('margin:', JSON.stringify(res));
} else {
  console.log('Commands: open <coin> <leverage> <usd> | margin <coin> <+/-usd>');
}
