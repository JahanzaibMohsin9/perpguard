// Move free Ethereum Sepolia ETH to Arbitrum Sepolia (gas for fund-testnet.ts).
// Uses the official Arbitrum Sepolia Inbox on Sepolia (verified 2026-11-23:
// bridge() = 0x38f918D0E9F1b721EDaA41302E399fa1B79333a9). Arrives at the same address in ~10-15 min.
//
// Usage (from backend/):
//   npx tsx scripts/bridge-gas.ts          -> show balances on both chains
//   npx tsx scripts/bridge-gas.ts send     -> bridge (balance minus a gas reserve, max 0.02 ETH)

import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, fallback, formatEther, http, parseAbi, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia, sepolia } from 'viem/chains';

const INBOX = '0xaAe29B0366299461418F5324a79Afc425BE5ae21' as const;
const sepoliaTransport = () =>
  fallback(
    ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org', 'https://1rpc.io/sepolia', 'https://rpc.sepolia.org'].map(
      (u) => http(u, { timeout: 20_000 }),
    ),
  );

const key = readFileSync(new URL('../.env.funder', import.meta.url), 'utf8').match(/FUNDER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/)?.[1];
if (!key) throw new Error('No funder key. Run scripts/fund-testnet.ts first.');
const account = privateKeyToAccount(key as Hex);

const l1 = createPublicClient({ chain: sepolia, transport: sepoliaTransport() });
const l2 = createPublicClient({ chain: arbitrumSepolia, transport: http() });
const [l1Bal, l2Bal] = await Promise.all([l1.getBalance({ address: account.address }), l2.getBalance({ address: account.address })]);
console.log(`Funder: ${account.address}`);
console.log(`  Ethereum Sepolia ETH: ${formatEther(l1Bal)}`);
console.log(`  Arbitrum Sepolia ETH: ${formatEther(l2Bal)}`);

if (process.argv[2] === 'send') await send();

async function send() {
  const reserve = parseEther('0.002'); // keep some for the L1 tx fee
  const max = parseEther('0.02');
  let value = l1Bal - reserve;
  if (value > max) value = max;
  if (value <= 0n) throw new Error('Not enough Ethereum Sepolia ETH to bridge.');

  const abi = parseAbi(['function depositEth() payable returns (uint256)']);
  await l1.simulateContract({ account, address: INBOX, abi, functionName: 'depositEth', value });
  const wallet = createWalletClient({ account, chain: sepolia, transport: sepoliaTransport() });
  const hash = await wallet.writeContract({ address: INBOX, abi, functionName: 'depositEth', value });
  console.log(`Bridging ${formatEther(value)} ETH. Sepolia tx: https://sepolia.etherscan.io/tx/${hash}`);
  const r = await l1.waitForTransactionReceipt({ hash });
  console.log(`L1 status: ${r.status}. ETH appears on Arbitrum Sepolia in ~10-15 minutes.`);
}
