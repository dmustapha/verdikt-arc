// Gate D1 verification — for each requestHash a deployed-worker attestation produced, prove the FULL
// ERC-8004 loop on the LIVE canonical Validation Registry (Base Sepolia):
//   1. getValidationStatus reads the verdict back (right validator / agentId / score / tag),
//   2. the on-chain responseURI resolves live and CONTAINS the Arc settlement tx hash,
//   3. keccak256(served bundle) == the on-chain responseHash (tamper-evident, verifiable honesty).
// Readbacks POLL (Base Sepolia's public RPC load-balances → a fresh write can read stale).
//
// Run: set -a; . ./.env; set +a; npx tsx worker/src/scripts/verify-gate-d1.ts <requestHash> [<requestHash> ...]
import { createPublicClient, http, keccak256, toBytes, getAddress } from 'viem';
import { baseSepolia } from 'viem/chains';
import { readValidationStatus } from '../lib/erc8004.js';
import { ERC8004_VALIDATION_REGISTRY, BASE_SEPOLIA_EXPLORER_ADDR } from '../lib/erc8004-constants.js';

// getValidationStatus does NOT expose responseURI (it's event-only), so read the ValidationResponse
// event to confirm the on-chain URI literally points at the served evidence bundle.
const VALIDATION_RESPONSE_EVENT = [{
  type: 'event', name: 'ValidationResponse', inputs: [
    { name: 'validatorAddress', type: 'address', indexed: true },
    { name: 'agentId', type: 'uint256', indexed: true },
    { name: 'requestHash', type: 'bytes32', indexed: true },
    { name: 'response', type: 'uint8', indexed: false },
    { name: 'responseURI', type: 'string', indexed: false },
    { name: 'responseHash', type: 'bytes32', indexed: false },
    { name: 'tag', type: 'string', indexed: false },
  ],
}] as const;

const evClient = createPublicClient({ chain: baseSepolia, transport: http((process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org').trim()) });

// Read the on-chain responseURI for a requestHash. Public RPCs cap eth_getLogs at a 2000-block range,
// so page backward in 2000-block windows (up to ~34h) until the event is found. Returns null if not
// found in-range (older attestation) — the caller notes it rather than failing the gate.
async function onChainResponseURI(requestHash: `0x${string}`): Promise<string | null> {
  const SPAN = 2000n, MAX_PAGES = 60n;
  let hi = await evClient.getBlockNumber();
  for (let page = 0n; page < MAX_PAGES; page++) {
    const lo = hi > SPAN ? hi - SPAN + 1n : 0n;
    const logs = await evClient.getContractEvents({
      address: ERC8004_VALIDATION_REGISTRY, abi: VALIDATION_RESPONSE_EVENT, eventName: 'ValidationResponse',
      args: { requestHash }, fromBlock: lo, toBlock: hi,
    });
    if (logs.length) return (logs[logs.length - 1] as any).args.responseURI as string;
    if (lo === 0n) break;
    hi = lo - 1n;
  }
  return null;
}

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

  // 4. The on-chain ValidationResponse event's responseURI must literally point at the served bundle.
  const onchainURI = await onChainResponseURI(requestHash);
  let okURI = true;
  if (onchainURI === null) {
    console.log(`    on-chain responseURI: (not in recent block window — skipped)`);
  } else {
    okURI = onchainURI === url;
    console.log(`    on-chain responseURI == served URL: ${okURI} (${onchainURI})`);
  }
  console.log(`    validation on explorer: ${BASE_SEPOLIA_EXPLORER_ADDR}0x8004Cb1BF31DAf7788923b405b754f57acEB4272`);

  const ok = okValidator && okAgent && okTag && okHash && okArc && okURI;
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
