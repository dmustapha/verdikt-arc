// WS5.7 — provision a DEDICATED, low-balance x402 toll-payer key on Arc so the worker's x402 driver is
// live (not the refusing stub in buildX402Driver). This key ONLY ever pays sub-cent access tolls; it
// never touches the bounty (the reconciliation invariant is enforced in the driver's requirements
// selector). Per the funds-key lesson: dedicated key, LOW balance, kept out of .env.local clobber range
// — it goes into a Fly SECRET plus a single 0600 gitignored local backup, never committed.
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/setup-x402-toll-key.ts
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { arcTestnet } from '../lib/chains.js';

const USDC = '0x3600000000000000000000000000000000000000' as const;
const EXPLORER = 'https://testnet.arcscan.app';
const FUND_USDC = process.env.TOLL_FUND_USDC ?? '0.10'; // low balance by design
const ERC20_TRANSFER = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;

async function main() {
  const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
  if (!payerKey) throw new Error('DEMO_PAYER_KEY required to fund the toll key');

  const tollKey = generatePrivateKey();
  const toll = privateKeyToAccount(tollKey);

  const wallet = createWalletClient({ account: privateKeyToAccount(payerKey), chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
  const tx = await wallet.writeContract({ address: USDC, abi: ERC20_TRANSFER, functionName: 'transfer', args: [toll.address, parseUnits(FUND_USDC, 6)] });

  // Single 0600 local backup, OUTSIDE the .env / .env.local clobber range (worker/.secrets is gitignored).
  const keyFile = fileURLToPath(new URL('../../.secrets/x402-toll.key', import.meta.url));
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, `${tollKey}\n`, { mode: 0o600 });

  console.log(`x402 toll key provisioned:`);
  console.log(`  address:  ${toll.address}`);
  console.log(`  funded:   ${FUND_USDC} USDC  ${EXPLORER}/tx/${tx}`);
  console.log(`  backup:   worker/.secrets/x402-toll.key (0600, gitignored)`);
  console.log(`\nSet the Fly secret WITHOUT echoing the value:`);
  console.log(`  cd worker && printf 'X402_TOLL_PAYER_KEY=%s\\n' "$(cat .secrets/x402-toll.key)" | fly secrets import`);
  process.exit(0);
}

main().catch((e) => { console.error('TOLL KEY SETUP FAILED:', e); process.exit(1); });
