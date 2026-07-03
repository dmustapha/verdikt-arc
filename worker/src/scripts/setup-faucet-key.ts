// WS7 hardening — provision a DEDICATED, LOW-balance faucet key, decoupled from the settlement/demo
// key so the public /faucet can never drain funds that matter (funds-key lesson). Funds it with a
// little Arc native gas (to send drip txs) and a small ERC-20 USDC balance (the drip pool). A small
// balance is the point: it caps total faucet exposure regardless of rate limits.
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/setup-faucet-key.ts
import { createWalletClient, createPublicClient, http, parseEther, parseUnits, formatEther, encodeFunctionData } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { arcTestnet, ARC_USDC_ADDRESS } from '../lib/chains.js';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const RPC = process.env.ARC_RPC_URL;
const FUND_NATIVE = process.env.FAUCET_KEY_NATIVE ?? '0.3'; // gas for many drip txs
const FUND_USDC = Number(process.env.FAUCET_KEY_USDC ?? 8);  // the drip pool (small on purpose)
const TRANSFER_ABI = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;

async function main() {
  const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
  if (!payerKey) throw new Error('DEMO_PAYER_KEY required to fund the faucet key');
  const payer = privateKeyToAccount(payerKey);
  const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
  const wallet = createWalletClient({ account: payer, chain: arcTestnet, transport: http(RPC) });

  const bal = await pub.getBalance({ address: payer.address });
  console.log(`payer ${payer.address}: ${formatEther(bal)} native gas on Arc`);
  if (bal < parseEther(FUND_NATIVE)) throw new Error(`payer has < ${FUND_NATIVE} native gas`);

  const faucetKey = generatePrivateKey();
  const faucet = privateKeyToAccount(faucetKey);

  const nativeTx = await wallet.sendTransaction({ to: faucet.address, value: parseEther(FUND_NATIVE) });
  await pub.waitForTransactionReceipt({ hash: nativeTx, timeout: 90_000 });
  const usdcTx = await wallet.sendTransaction({ to: ARC_USDC_ADDRESS, data: encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [faucet.address, parseUnits(FUND_USDC.toFixed(6), 6)] }) });
  await pub.waitForTransactionReceipt({ hash: usdcTx, timeout: 90_000 });

  const keyFile = fileURLToPath(new URL('../../.secrets/faucet.key', import.meta.url));
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, `${faucetKey}\n`, { mode: 0o600 });

  console.log(`\nFaucet key provisioned (dedicated, low-balance):`);
  console.log(`  address:  ${faucet.address}`);
  console.log(`  native:   ${FUND_NATIVE}  (${nativeTx})`);
  console.log(`  usdc:     ${FUND_USDC}    (${usdcTx})`);
  console.log(`  backup:   worker/.secrets/faucet.key (0600, gitignored)`);
  console.log(`\n  ADD TO .env:  FAUCET_ADDRESS=${faucet.address}`);
  console.log(`  Fly secret (no echo):  cd worker && printf 'FAUCET_KEY=%s\\n' "$(cat .secrets/faucet.key)" | fly secrets import`);
  process.exit(0);
}
main().catch((e) => { console.error('FAUCET KEY SETUP FAILED:', e.message); process.exit(1); });
