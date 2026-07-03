// Boundary #3 — provision a DEDICATED settler wallet for the self-hosted x402 facilitator on Arc. The
// facilitator's settle() submits the toll's EIP-3009 transferWithAuthorization ON-CHAIN, so the settler
// pays gas (on Arc, gas IS USDC) and needs a small Arc USDC balance. Same funds-key hygiene as the toll
// key: dedicated key, LOW balance, Fly secret + one 0600 gitignored backup, never .env.local.
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/setup-x402-settler-key.ts
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { arcTestnet } from '../lib/chains.js';

const USDC = '0x3600000000000000000000000000000000000000' as const;
const EXPLORER = 'https://testnet.arcscan.app';
const FUND_USDC = process.env.SETTLER_FUND_USDC ?? '0.50'; // small — only settle gas
const ERC20_TRANSFER = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;

async function main() {
  const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
  if (!payerKey) throw new Error('DEMO_PAYER_KEY required to fund the settler');

  const settlerKey = generatePrivateKey();
  const settler = privateKeyToAccount(settlerKey);

  const wallet = createWalletClient({ account: privateKeyToAccount(payerKey), chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
  const tx = await wallet.writeContract({ address: USDC, abi: ERC20_TRANSFER, functionName: 'transfer', args: [settler.address, parseUnits(FUND_USDC, 6)] });

  const keyFile = fileURLToPath(new URL('../../.secrets/x402-settler.key', import.meta.url));
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, `${settlerKey}\n`, { mode: 0o600 });

  console.log(`x402 facilitator settler wallet provisioned:`);
  console.log(`  address:  ${settler.address}`);
  console.log(`  funded:   ${FUND_USDC} USDC  ${EXPLORER}/tx/${tx}`);
  console.log(`  backup:   worker/.secrets/x402-settler.key (0600, gitignored)`);
  console.log(`\nSet the facilitator's Fly secret WITHOUT echoing the value:`);
  console.log(`  printf 'X402_SETTLER_KEY=%s\\n' "$(cat worker/.secrets/x402-settler.key)" | fly secrets import --app verdikt-x402-facilitator`);
  process.exit(0);
}

main().catch((e) => { console.error('SETTLER KEY SETUP FAILED:', e); process.exit(1); });
