// WS7 — provision a DEDICATED gas-only RELAYER key for the human web path, separate from
// DEMO_PAYER_KEY. This key ONLY ever pays Arc gas to submit fundWithAuthorizationFor on behalf of a
// human who signed an EIP-3009 authorization in their browser. It never signs authorizations, never
// holds bounty USDC, and cannot redirect funds (routes are folded into the payer's signed nonce).
// Per the funds-key lesson: dedicated key, LOW balance, kept OUT of the .env.local clobber range —
// Fly SECRET + one 0600 gitignored local backup.
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/setup-relayer-key.ts
import { createWalletClient, createPublicClient, http, parseEther, formatEther } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { arcTestnet } from '../lib/chains.js';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const RPC = process.env.ARC_RPC_URL;
// Arc's native gas currency is "USD Coin" (18 decimals) — parseEther matches its scale.
const FUND_NATIVE = process.env.RELAYER_FUND_NATIVE ?? '1'; // low, gas-only; funds many relay txs

async function main() {
  const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
  if (!payerKey) throw new Error('DEMO_PAYER_KEY required to fund the relayer key');
  const payer = privateKeyToAccount(payerKey);
  const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });

  const bal = await pub.getBalance({ address: payer.address });
  console.log(`payer ${payer.address}: ${formatEther(bal)} native gas on Arc`);
  if (bal < parseEther(FUND_NATIVE)) throw new Error(`payer has < ${FUND_NATIVE} native gas — top up Arc first`);

  const relayerKey = generatePrivateKey();
  const relayer = privateKeyToAccount(relayerKey);

  const wallet = createWalletClient({ account: payer, chain: arcTestnet, transport: http(RPC) });
  const tx = await wallet.sendTransaction({ to: relayer.address, value: parseEther(FUND_NATIVE) });
  await pub.waitForTransactionReceipt({ hash: tx, timeout: 90_000 });

  // Single 0600 local backup, OUTSIDE the .env / .env.local clobber range (worker/.secrets is gitignored).
  const keyFile = fileURLToPath(new URL('../../.secrets/relayer.key', import.meta.url));
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, `${relayerKey}\n`, { mode: 0o600 });

  console.log(`\nRelayer key provisioned:`);
  console.log(`  address:  ${relayer.address}`);
  console.log(`  funded:   ${FUND_NATIVE} native  https://testnet.arcscan.app/tx/${tx}`);
  console.log(`  backup:   worker/.secrets/relayer.key (0600, gitignored)`);
  console.log(`\n  ADD TO .env:  RELAYER_ADDRESS=${relayer.address}`);
  console.log(`                RELAYER_KEY=$(cat worker/.secrets/relayer.key)   # do NOT echo`);
  console.log(`  Fly secret (no echo):`);
  console.log(`    cd worker && printf 'RELAYER_KEY=%s\\n' "$(cat .secrets/relayer.key)" | fly secrets import`);
  process.exit(0);
}

main().catch((e) => { console.error('RELAYER KEY SETUP FAILED:', e.message); process.exit(1); });
