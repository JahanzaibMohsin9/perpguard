// Order signing and number formatting for Hyperliquid's /exchange endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { actionHash, l1TypedData, roundPx, roundSz, toWire } from '../src/exchange.ts';

// Golden vector from the official hyperliquid-python-sdk test suite
// (test_phantom_agent_creation_matches_production): ETH order, nonce 1677777606040.
test('action hash matches the official Python SDK vector', () => {
  const action = {
    type: 'order',
    orders: [{ a: 4, b: true, p: '1670.1', s: '0.0147', r: false, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
  };
  assert.equal(actionHash(action, 1677777606040), '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908');
});

test('L1 signature recovers to the agent address, and the network changes the payload', async () => {
  // Well-known throwaway test key (never funded).
  const agent = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const action = { type: 'order', orders: [], grouping: 'na' };
  const typed = l1TypedData('testnet', action, 1);
  const signature = await agent.signTypedData(typed);
  assert.equal(await recoverTypedDataAddress({ ...typed, signature }), agent.address);
  assert.equal(typed.message.source, 'b'); // testnet
  assert.equal(l1TypedData('mainnet', action, 1).message.source, 'a');
});

test('the nonce is part of the hash, so replays are distinct', () => {
  const action = { type: 'cancel', cancels: [{ a: 3, o: 1 }] };
  assert.notEqual(actionHash(action, 1), actionHash(action, 2));
});

test('toWire formats numbers like the SDK float_to_wire', () => {
  assert.equal(toWire(1670.1), '1670.1');
  assert.equal(toWire(0.01672), '0.01672');
  assert.equal(toWire(59509), '59509');
  assert.equal(toWire(-0), '0');
  assert.equal(toWire(0.000000001), '0');
});

test('prices round to 5 significant figures and the asset decimal limit', () => {
  assert.equal(roundPx(59509.4567, 5), 59509); // BTC
  assert.equal(roundPx(1679.5678, 4), 1679.6); // ETH
  assert.equal(roundPx(0.123456789, 0), 0.12346); // max 6 decimals when szDecimals is 0
  assert.equal(roundSz(0.016725, 5), 0.01673);
  assert.equal(roundSz(3.86163, 4), 3.8616);
});
