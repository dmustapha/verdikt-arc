// Gate D1 verification — for each requestHash a deployed-worker attestation produced, prove the FULL
// ERC-8004 loop on the LIVE canonical Validation Registry (Base Sepolia):
//   1. getValidationStatus reads the verdict back (right validator / agentId / score / tag),
//   2. the on-chain responseURI resolves live and CONTAINS the Arc settlement tx hash,
//   3. keccak256(served bundle) == the on-chain responseHash (tamper-evident, verifiable honesty).
// Readbacks POLL (Base Sepolia's public RPC load-balances → a fresh write can read stale).
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/verify-gate-d1.ts <requestHash> [<requestHash> ...]
import { keccak256, toBytes, getAddress } from 'viem';
import { readValidationStatus } from '../lib/erc8004.js';
import { BASE_SEPOLIA_EXPLORER_ADDR } from '../lib/erc8004-constants.js';

const WORKER = (process.env.WORKER_PUBLIC_URL ?? 'https://verdikt-worker.fly.dev').replace(/\/+$/, '');
const VALIDATOR = getAddress(process.env.ERC8004_ATTESTOR_ADDRESS ?? '0xD089Dfc911ea0A5cA7A54ff912ab73B5531D02D7');
const AGENT_ID = BigInt(process.env.ERC8004_AGENT_ID ?? '7395');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function verifyOne(requestHash: `0x${string}`): Promise<boolean> {
  console.log(`\n── requestHash ${requestHash}`);

  // 1. Poll the on-chain read until the response has propagated (tag set).
  let status = null as Awaited<ReturnType<typeof readValidationStatus>>;
  for (let i = 0; i < 10 && !(status && status.tag !== ''); i++) {
    status = await readValidationStatus(requestHash);
    if (status && status.tag !== '') break;
    await sleep(3000);
  }
  if (!status || status.tag === '') { console.error('  ✗ no response on-chain (never propagated)'); return false; }
  const okValidator = getAddress(status.validatorAddress) === VALIDATOR;
  const okAgent = status.agentId === AGENT_ID;
  const okTag = status.tag.startsWith('verdikt:');
  console.log(`  getValidationStatus: validator=${status.validatorAddress} agentId=${status.agentId} response=${status.response} tag=${status.tag}`);
  console.log(`    validator match=${okValidator}  agentId match=${okAgent}  tag ok=${okTag}`);

  // 2 + 3. Evidence URL resolves live, carries the Arc tx, and hashes to the on-chain responseHash.
  const url = `${WORKER}/evidence/${requestHash}.json`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`  ✗ evidence URL ${url} -> HTTP ${res.status}`); return false; }
  const body = await res.text();
  const bundle = JSON.parse(body);
  const servedHash = keccak256(toBytes(body));
  const okHash = servedHash.toLowerCase() === status.responseHash.toLowerCase();
  const arcTx = bundle?.settlement?.txHash as string | undefined;
  const okArc = !!arcTx && body.includes(arcTx);
  console.log(`  evidence URL: ${url} -> HTTP 200`);
  console.log(`    keccak256(served) == on-chain responseHash: ${okHash}`);
  console.log(`    Arc settlement tx in bundle: ${okArc} (${arcTx})`);
  console.log(`    outcome=${bundle.outcome} verdict=${bundle.verdict} response=${bundle.response}`);
  console.log(`    validation on explorer: ${BASE_SEPOLIA_EXPLORER_ADDR}0x8004Cb1BF31DAf7788923b405b754f57acEB4272`);

  const ok = okValidator && okAgent && okTag && okHash && okArc;
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'} for ${requestHash}`);
  return ok;
}

async function main() {
  const hashes = process.argv.slice(2) as `0x${string}`[];
  if (!hashes.length) throw new Error('usage: verify-gate-d1.ts <requestHash> [...]');
  let allOk = true;
  for (const h of hashes) allOk = (await verifyOne(h)) && allOk;
  console.log(`\n${allOk ? '✅ Gate D1 VERIFIED' : '❌ Gate D1 FAILED'} — ${hashes.length} attestation(s) checked on canonical Base Sepolia.`);
  if (!allOk) process.exit(1);
}

main().catch((e) => { console.error('verify-gate-d1 FAIL:', e.message); process.exit(1); });
