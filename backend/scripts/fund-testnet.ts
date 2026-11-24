// Fund a Hyperliquid TESTNET account for free, without a mainnet deposit.
//
// WARNING (2026-11-24): Hyperliquid's testnet deposit wallet drops most CCTP forwards, so
// the USDC often never arrives. The reliable route is a >=5 USDC mainnet deposit and then
// the faucet at app.hyperliquid-testnet.xyz/drip. Kept for reference.
//
// Route (Circle's official CCTP -> HyperCore path, testnet edition):
//   free Circle test USDC on Arbitrum Sepolia  --CCTP fast transfer-->  HyperEVM testnet
//   --> CctpForwarder --> HyperCore testnet perps balance of RECIPIENT
// Docs: https://developers.circle.com/cctp/howtos/transfer-usdc-from-arbitrum-to-hypercore
//
// A throwaway "funder" wallet holds the faucet funds and signs; the user's own wallet
// keys are never needed. The funder key lives in backend/.env.funder (git-ignored).
//
// Usage (from backend/):
//   npx tsx scripts/fund-testnet.ts            -> create funder if needed, show address + balances
//   npx tsx scripts/fund-testnet.ts send 10    -> send 10 USDC to RECIPIENT on Hyperliquid testnet

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  pad,
  parseAbi,
  parseSignature,
  parseUnits,
  toHex,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';

// ---- verified 2026-11-23 against Circle docs + on-chain (name "USD Coin", version "2", 6 decimals)
const USDC = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' as const; // Arbitrum Sepolia
const CCTP_EXTENSION = '0x8E4e3d0E95C1bEC4F3eC7F69aa48473E0Ab6eB8D' as const; // Arbitrum Sepolia
const CCTP_FORWARDER = '0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2' as const; // HyperEVM testnet
const HYPEREVM_TESTNET_RPC = 'https://rpc.hyperliquid-testnet.xyz/evm';
const DEST_DOMAIN_HYPEREVM = 19;
const FAST_FINALITY = 1000;
const FORWARD_FEE = 200_000n; // 0.20 USDC flat forwarding fee
const DEX_PERPS = 0;

// The user's wallet that should receive testnet USDC on Hyperliquid.
const RECIPIENT = getAddress(process.env.RECIPIENT ?? '0xc1bBF5a49b4F8B7CF0CE9efa1988f25892a654c7');

const KEY_FILE = new URL('../.env.funder', import.meta.url);

function loadOrCreateFunderKey(): Hex {
  if (existsSync(KEY_FILE)) {
    const m = readFileSync(KEY_FILE, 'utf8').match(/FUNDER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/);
    if (m) return m[1] as Hex;
  }
  const key = generatePrivateKey();
  writeFileSync(KEY_FILE, `# Throwaway TESTNET funder wallet. Never commit. Never fund with real money.\nFUNDER_PRIVATE_KEY=${key}\n`);
  console.log('Created new funder wallet (key saved to backend/.env.funder).');
  return key;
}

/** Circle CCTP forward hook: "cctp-forward" magic (24 bytes) | version u32 | length u32 | recipient (20) | dex u32 */
function encodeForwardHookData(recipient: Hex, dex: number): Hex {
  const magic = Buffer.alloc(24);
  magic.write('cctp-forward', 'ascii');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(0, 0); // version
  header.writeUInt32BE(24, 4); // data length: 20-byte recipient + 4-byte dex
  const recip = Buffer.from(recipient.slice(2).toLowerCase(), 'hex');
  const dexBuf = Buffer.alloc(4);
  dexBuf.writeUInt32BE(dex >>> 0, 0);
  const out = Buffer.concat([magic, header, recip, dexBuf]);
  if (out.length !== 56) throw new Error(`hookData must be 56 bytes, got ${out.length}`);
  return toHex(out);
}

const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const extensionAbi = parseAbi([
  'struct ReceiveWithAuthorizationData { uint256 amount; uint256 authValidAfter; uint256 authValidBefore; bytes32 authNonce; uint8 v; bytes32 r; bytes32 s; }',
  'struct DepositForBurnData { uint256 amount; uint32 destinationDomain; bytes32 mintRecipient; bytes32 destinationCaller; uint256 maxFee; uint32 minFinalityThreshold; bytes hookData; }',
  'function batchDepositForBurnWithAuth(ReceiveWithAuthorizationData _receiveWithAuthorizationData, DepositForBurnData _depositForBurnData)',
]);

const account = privateKeyToAccount(loadOrCreateFunderKey());
const pub = createPublicClient({ chain: arbitrumSepolia, transport: http() });

const [eth, usdc] = await Promise.all([
  pub.getBalance({ address: account.address }),
  pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
]);
console.log(`Funder address (Arbitrum Sepolia): ${account.address}`);
console.log(`  ETH  (gas): ${formatEther(eth)}`);
console.log(`  USDC      : ${formatUnits(usdc, 6)}`);
console.log(`Recipient on Hyperliquid testnet: ${RECIPIENT}`);

if (process.argv[2] === 'send') await send();

async function send() {
const amount = parseUnits(process.argv[3] ?? '10', 6);
if (amount <= FORWARD_FEE) throw new Error('Amount must be more than the 0.20 USDC forwarding fee.');
if (usdc < amount) throw new Error(`Not enough USDC: have ${formatUnits(usdc, 6)}, need ${formatUnits(amount, 6)}.`);
if (eth === 0n) throw new Error('Funder has no Arbitrum Sepolia ETH for gas.');

// Safety: the forwarder must exist on HyperEVM testnet, or funds would be stuck forever.
const hyperEvm = createPublicClient({ transport: http(HYPEREVM_TESTNET_RPC) });
const fwdCode = await hyperEvm.getCode({ address: CCTP_FORWARDER });
if (!fwdCode || fwdCode === '0x') throw new Error('CctpForwarder not found on HyperEVM testnet. Aborting.');

// Live fee check: abort if Circle's forwarding fee changed.
const fees = (await (await fetch(
  `https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/3/${DEST_DOMAIN_HYPEREVM}?forward=true&hyperCoreDeposit=true`,
)).json()) as Array<{ finalityThreshold: number; minimumFee: number; forwardFee: { high: number } }>;
const fast = fees.find((f) => f.finalityThreshold === FAST_FINALITY);
if (!fast || BigInt(fast.forwardFee.high) > FORWARD_FEE || fast.minimumFee !== 0) {
  throw new Error(`Unexpected fee schedule: ${JSON.stringify(fees)}`);
}

const now = BigInt(Math.floor(Date.now() / 1000));
const validAfter = now - 3600n;
const validBefore = now + 3600n;
const nonce = toHex(randomBytes(32));

const signature = await account.signTypedData({
  domain: { name: 'USD Coin', version: '2', chainId: arbitrumSepolia.id, verifyingContract: USDC },
  types: {
    ReceiveWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'ReceiveWithAuthorization',
  message: { from: account.address, to: CCTP_EXTENSION, value: amount, validAfter, validBefore, nonce },
});
const { r, s, v, yParity } = parseSignature(signature);
const vNum = v !== undefined ? Number(v) : yParity + 27;

const forwarder32 = pad(CCTP_FORWARDER, { size: 32 });
const hookData = encodeForwardHookData(RECIPIENT, DEX_PERPS);

const wallet = createWalletClient({ account, chain: arbitrumSepolia, transport: http() });
const args = [
  { amount, authValidAfter: validAfter, authValidBefore: validBefore, authNonce: nonce, v: vNum, r, s },
  {
    amount,
    destinationDomain: DEST_DOMAIN_HYPEREVM,
    mintRecipient: forwarder32, // must be the forwarder, or funds are stuck
    destinationCaller: forwarder32, // must be the forwarder, or funds are stuck
    maxFee: FORWARD_FEE,
    minFinalityThreshold: FAST_FINALITY,
    hookData,
  },
] as const;

// Simulate first: reverts here cost nothing.
await pub.simulateContract({ account, address: CCTP_EXTENSION, abi: extensionAbi, functionName: 'batchDepositForBurnWithAuth', args });
const hash = await wallet.writeContract({ address: CCTP_EXTENSION, abi: extensionAbi, functionName: 'batchDepositForBurnWithAuth', args });
console.log(`Sent. Arbitrum Sepolia tx: https://sepolia.arbiscan.io/tx/${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`Status: ${receipt.status}. Expect ~${formatUnits(amount - FORWARD_FEE, 6)} USDC in the Hyperliquid testnet perps balance within a few minutes.`);
}
