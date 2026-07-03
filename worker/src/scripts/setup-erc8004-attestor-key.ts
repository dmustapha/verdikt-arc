// Review #10 — provision a DEDICATED ERC-8004 attestor/validator key, separate from DEMO_PAYER_KEY.
// The on-chain validatorAddress (and the fresh agent NFT owner) should be a purpose-built identity, NOT
// the shared demo/settlement key that also controls bounty USDC. This key only ever pays Base Sepolia
// gas to open validationRequests and post validationResponses. Per the funds-key lesson: dedicated key,
// LOW balance, kept OUT of the .env.local clobber range — Fly SECRET + one 0600 gitignored local backup.
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/setup-erc8004-attestor-key.ts
import { createWalletClient, createPublicClient, http, parseEther, formatEther } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const RPC = (process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org').trim();
const FUND_ETH = process.env.ATTESTOR_FUND_ETH ?? '0.02'; // low, gas-only

async function main() {
  const payerKey = process.env.DEMO_PAYER_KEY as `0x${string}`;
  if (!payerKey) throw new Error('DEMO_PAYER_KEY required to fund the attestor key');
  const payer = privateKeyToAccount(payerKey);
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

  const bal = await pub.getBalance({ address: payer.address });
  console.log(`payer ${payer.address}: ${formatEther(bal)} ETH on Base Sepolia`);
  if (bal < parseEther(FUND_ETH)) throw new Error(`payer has < ${FUND_ETH} ETH — top up Base Sepolia gas first`);

  const attestorKey = generatePrivateKey();
  const attestor = privateKeyToAccount(attestorKey);

  const wallet = createWalletClient({ account: payer, chain: baseSepolia, transport: http(RPC) });
  const tx = await wallet.sendTransaction({ to: attestor.address, value: parseEther(FUND_ETH) });
  await pub.waitForTransactionReceipt({ hash: tx, timeout: 90_000 });

  // Single 0600 local backup, OUTSIDE the .env / .env.local clobber range (worker/.secrets is gitignored).
  const keyFile = fileURLToPath(new URL('../../.secrets/erc8004-attestor.key', import.meta.url));
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, `${attestorKey}\n`, { mode: 0o600 });

  console.log(`\nERC-8004 attestor key provisioned:`);
  console.log(`  address:  ${attestor.address}`);
  console.log(`  funded:   ${FUND_ETH} ETH  https://sepolia.basescan.org/tx/${tx}`);
  console.log(`  backup:   worker/.secrets/erc8004-attestor.key (0600, gitignored)`);
  console.log(`\n  ADD TO .env:  ERC8004_ATTESTOR_ADDRESS=${attestor.address}`);
  console.log(`  Next: register a fresh agent owned by this key, then set the Fly secret WITHOUT echoing:`);
  console.log(`    ERC8004_ATTESTOR_KEY=$(cat worker/.secrets/erc8004-attestor.key) npx tsx worker/src/scripts/register-erc8004-agent.ts`);
  console.log(`    cd worker && printf 'ERC8004_ATTESTOR_KEY=%s\\n' "$(cat .secrets/erc8004-attestor.key)" | fly secrets import`);
  process.exit(0);
}

main().catch((e) => { console.error('ATTESTOR KEY SETUP FAILED:', e.message); process.exit(1); });
