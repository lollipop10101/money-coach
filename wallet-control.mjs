/**
 * wallet-control.mjs
 * Wallet control: generate keypair, check balance, send transfers.
 * Run: node wallet-control.mjs
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

const RPC = 'https://rpc.mainnet.sui.io';

async function rpc(method, params = []) {
  const resp = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const out = await resp.json();
  return out.result ?? out.error;
}

async function getBalance(addr) {
  const bal = await rpc('suix_getBalance', [addr, '0x2::sui::SUI']);
  return parseInt(bal?.totalBalance ?? 0);
}

// Load from the fresh key generated earlier
const WALLET_SECRET = 'suiprivkey1qp7ecfwpsa8ynmd3jxx9wvj322r4zey2kpypjp4xf6pk4ug6u2ptcatgg60';
const keypair = Ed25519Keypair.fromSecretKey(WALLET_SECRET);
const addr = keypair.getPublicKey().toSuiAddress();
console.log('Address:', addr);

const balance = await getBalance(addr);
console.log('Balance:', (balance / 1_000_000).toFixed(4), 'SUI');

if (balance === 0) {
  console.log('No SUI — waiting for deposit.');
  process.exit(0);
}

// Build + sign + broadcast a self-transfer test
const tx = new Transaction();
tx.setSender(addr);
const [coin] = tx.splitCoins(tx.gas, [Math.floor(balance / 2)]);
tx.transferObjects([coin], addr);

const txBytes = await tx.build({ client: { httpEndpoint: RPC } });
const { signature } = await keypair.signTransaction(txBytes);
console.log('Signed! txBytes:', txBytes.length, 'sig:', signature.length);

const result = await rpc('sui_executeTransactionBlock', [txBytes, signature, { onlyTransactionEffects: false }]);
console.log('Result:', JSON.stringify(result)?.slice(0, 300));
