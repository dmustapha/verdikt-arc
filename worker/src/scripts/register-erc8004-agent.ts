// D1.5 — register ONE real agent NFT in the canonical ERC-8004 Identity Registry on Base Sepolia.
// The attestor owns it (so it can open validationRequests) and is also the named validator: the NFT
// represents a Verdikt-operated reference seller whose delivered work Verdikt validates. Idempotent-ish:
// if ERC8004_AGENT_ID is already set and resolves to an NFT owned by the attestor, it no-ops.
//
// Run: from repo root `set -a; . ./.env; set +a` then `npx tsx worker/src/scripts/register-erc8004-agent.ts`
import { createWalletClient, createPublicClient, http, decodeEventLog, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { writeFileSync } from 'node:fs';
import { IDENTITY_REGISTRY_ABI, readAgentIdentity } from '../lib/erc8004.js';
import { ERC8004_IDENTITY_REGISTRY, BASE_SEPOLIA_EXPLORER_TX } from '../lib/erc8004-constants.js';

const ATTESTOR_KEY = (process.env.ERC8004_ATTESTOR_KEY ?? process.env.DEMO_PAYER_KEY ?? '').trim() as `0x${string}`;
const RPC = (process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org').trim();

// A minimal, valid ERC-8004 registration card, inlined as a data URI so it's fully self-contained
// (no extra hosting) — same pattern as canonical agents 0/1.
const AGENT_CARD = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004',
  name: 'Verdikt Reference Seller',
  description: 'A Verdikt-operated task agent whose deliverables are settled on Arc (CCTP) and attested on-chain via ERC-8004.',
  url: 'https://verdikt-reference-sellers.fly.dev',
  skills: ['research-answer', 'data-transform', 'code'],
};

async function main() {
  if (!ATTESTOR_KEY) throw new Error('ERC8004_ATTESTOR_KEY or DEMO_PAYER_KEY required');
  const account = privateKeyToAccount(ATTESTOR_KEY);
  const transport = http(RPC);
  const wallet = createWalletClient({ account, chain: baseSepolia, transport });
  const pub = createPublicClient({ chain: baseSepolia, transport });
  console.log(`attestor/owner: ${account.address}`);

  // Idempotency: if an agentId is already configured and owned by us, stop.
  const existing = (process.env.ERC8004_AGENT_ID ?? '').trim();
  if (existing) {
    const id = await readAgentIdentity(BigInt(existing), pub);
    if (id && getAddress(id.owner) === account.address) {
      console.log(`ERC8004_AGENT_ID=${existing} already registered and owned by the attestor — nothing to do.`);
      return;
    }
    console.log(`ERC8004_AGENT_ID=${existing} set but not owned by the attestor — registering a fresh one.`);
  }

  const agentURI = 'data:application/json;base64,' + Buffer.from(JSON.stringify(AGENT_CARD)).toString('base64');
  console.log('registering agent (register(string agentURI))…');
  const hash = await wallet.writeContract({
    address: ERC8004_IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_ABI,
    functionName: 'register', args: [agentURI], account, chain: baseSepolia,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (rcpt.status !== 'success') throw new Error(`register reverted (tx ${hash})`);

  // Recover the minted agentId from the ERC-721 Transfer(from=0x0, to=attestor, tokenId) event.
  let agentId: bigint | null = null;
  for (const log of rcpt.logs) {
    if (getAddress(log.address) !== getAddress(ERC8004_IDENTITY_REGISTRY)) continue;
    try {
      const ev = decodeEventLog({ abi: IDENTITY_REGISTRY_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === 'Transfer' && getAddress((ev.args as any).to) === account.address) {
        agentId = (ev.args as any).tokenId as bigint;
        break;
      }
    } catch { /* not a Transfer log */ }
  }
  if (agentId === null) throw new Error('registered, but could not recover agentId from Transfer logs');

  const record = {
    agentId: agentId.toString(),
    owner: account.address,
    txHash: hash,
    explorerUrl: `${BASE_SEPOLIA_EXPLORER_TX}${hash}`,
    identityRegistry: ERC8004_IDENTITY_REGISTRY,
    agentCard: AGENT_CARD,
  };
  writeFileSync(new URL('../../erc8004-agent.json', import.meta.url), JSON.stringify(record, null, 2) + '\n');

  console.log('\n✓ registered ERC-8004 agent');
  console.log(`  agentId:  ${record.agentId}`);
  console.log(`  tx:       ${record.explorerUrl}`);
  console.log(`  record:   worker/erc8004-agent.json`);
  console.log(`\n  ADD TO .env:  ERC8004_AGENT_ID=${record.agentId}`);
}

main().catch((e) => { console.error('D1.5 FAIL:', e.message); process.exit(1); });
