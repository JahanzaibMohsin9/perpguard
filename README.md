# PerpGuard

**See how close your Hyperliquid position is to liquidation at a glance on Even Realities G2 glasses, then protect it in seconds with a tap or your voice.**

Built for *Heads Up: Even Realities Hackathon* (TVM Ventures & Daos Hub), Nov 23–29, 2026.
Tracks: **02 Crypto & DeFi (Hyperliquid)** + **01 Messaging (Telegram)**.

> ⚠️ Testnet only. PerpGuard runs on the Hyperliquid **testnet**, never holds user funds, and gives no financial advice. It only offers *protective* actions: it reduces risk and never opens new trades.

## Status

| Feature | Status |
|---|---|
| Live position card on G2: PnL, mark and liquidation price, distance to liquidation, safety bar | ✅ working (simulator) |
| Read any testnet address (spectator mode) | ✅ backend supports it |
| Tap to refresh, scroll through positions, double tap to exit | ✅ |
| Protective actions (close 50%, close all, stop at break-even, 2% stop) as real testnet orders through an agent wallet | ⏳ next |
| Voice commands (fixed phrases, speech-to-text via Whisper) | ⏳ |
| Telegram bot: liquidation alerts and order receipts; Mini App pairing | ⏳ |

## How it works

```
G2 glasses + R1 ring ⇄ Even Realities app (phone)
  └ WebView: glasses/  (Vite + TS + Even Hub SDK)  — UI cards, input. No secrets.
        ⇅ WebSocket
backend/  (Node + TS + Fastify)
  • polls Hyperliquid testnet /info (clearinghouseState + allMids)
  • computes liquidation distance, pushes snapshots to the glasses
  • (next) places protective orders with an API/agent wallet that can trade but cannot withdraw
shared/protocol.ts — message types used by both sides
```

## Run it locally

Requirements: Node.js 22.12 or later, plus the Even Hub tools:

```bash
npm i -g @evenrealities/evenhub-cli @evenrealities/evenhub-simulator
npm install
```

1. **Backend:** copy `backend/.env.example` to `backend/.env` and set `HL_WATCH_ADDRESS` to any Hyperliquid **testnet** address. Then run:
   ```bash
   npm run dev:backend        # http://localhost:8787
   ```
2. **Glasses app:**
   ```bash
   npm run dev:glasses        # http://localhost:5173
   npm run sim                # opens the Even Hub simulator on the app
   ```
3. To build a package for Even Hub: `npm run pack -w glasses`. Before packing, put the public backend origin in `glasses/app.json` → `permissions[network].whitelist`.

## What existed before the hackathon

Nothing. This repository was created on **Nov 23, 2026**, during build week. Everything here was written during the hackathon. It uses these open-source libraries: Even Hub SDK, Fastify, Vite and TypeScript.

## License

MIT
