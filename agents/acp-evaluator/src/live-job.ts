// WS12 — the FULL live end-to-end ACP job on Virtuals (Base mainnet). Nothing mocked.
//
// This process runs the buyer and the seller as two raw-EOA ACP agents (ViemEoaProviderAdapter). The
// registered Verdikt evaluator runs SEPARATELY as acp-client.ts and must be up first. The lifecycle:
//
//   buyer.createJob(evaluator = Verdikt) ─▶ seller.setBudget ─▶ buyer.fund (USDC) ─▶ seller.submit(JSON)
//     ─▶ Verdikt judges the deliverable via its verdict engine ─▶ complete / reject ON-CHAIN.
//
// The buyer only observes the terminal job.completed / job.rejected (third-party evaluation). At the end we
// scan the ACP contract's logs for this jobId and print every lifecycle tx hash — the on-chain proof.
//
// Run (evaluator must already be LIVE in another terminal):
//   set -a; . agents/acp-evaluator/.env; set +a
//   npx tsx agents/acp-evaluator/src/acp-client.ts   # terminal 1 (Verdikt evaluator)
//   npx tsx agents/acp-evaluator/src/live-job.ts     # terminal 2 (buyer + seller)   [--invalid to force a reject]
import { AcpAgent, AssetToken, ACP_ABI } from '@virtuals-protocol/acp-node-v2';
import type { JobSession, JobRoomEntry } from '@virtuals-protocol/acp-node-v2';
import { createPublicClient, http, parseEventLogs, type Hex, type Address } from 'viem';
import { base } from 'viem/chains';
import { ViemEoaProviderAdapter } from './viem-adapter.js';
import { buildJobDescription, VALID_DELIVERABLE, INVALID_DELIVERABLE, SERVICE_NAME } from './service-spec.js';

const CHAIN_ID = base.id; // 8453
const BUDGET_USDC = Number(process.env.LIVE_BUDGET_USDC ?? 0.1); // matches the SDK's documented example value
const ACP_CONTRACT = '0x238E541BfefD82238730D00a2208E5497F1832E0' as Address; // ACP core, Base mainnet
const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 240_000);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see agents/acp-evaluator/.env.example)`);
  return v;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const wantReject = process.argv.includes('--invalid');
  const deliverable = wantReject ? INVALID_DELIVERABLE : VALID_DELIVERABLE;
  const evaluatorAddress = requireEnv('ACP_WALLET_ADDRESS') as Address; // the registered Verdikt agent
  const sellerAddress = requireEnv('LIVE_SELLER_ADDRESS') as Address;

  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com'),
  });

  const buyer = await AcpAgent.create({ provider: new ViemEoaProviderAdapter(requireEnv('LIVE_BUYER_KEY') as Hex) });
  const seller = await AcpAgent.create({ provider: new ViemEoaProviderAdapter(requireEnv('LIVE_SELLER_KEY') as Hex) });

  type Terminal = { status: 'completed' | 'rejected'; reason: string };
  const box: { terminal: Terminal | null } = { terminal: null };
  let resolveTerminal: () => void = () => {};
  const terminalReached = new Promise<void>((r) => { resolveTerminal = r; });

  // SELLER (provider): propose the budget when the job appears, deliver once the buyer funds.
  seller.on('entry', async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind !== 'system') return;
    try {
      if (entry.event.type === 'job.created') {
        console.log(`[seller]  job ${session.jobId} created → setBudget ${BUDGET_USDC} USDC`);
        await session.setBudget(AssetToken.usdc(BUDGET_USDC, CHAIN_ID));
      } else if (entry.event.type === 'job.funded') {
        console.log(`[seller]  job ${session.jobId} funded → submit deliverable (${wantReject ? 'INVALID' : 'valid'})`);
        await session.submit(deliverable);
      }
    } catch (e) {
      console.error('[seller]  error:', e instanceof Error ? e.message : e);
    }
  });

  // BUYER (client): fund once the seller sets a budget; observe the terminal verdict (third-party evaluator).
  buyer.on('entry', async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind !== 'system') return;
    try {
      if (entry.event.type === 'budget.set') {
        console.log(`[buyer]   budget set on job ${session.jobId} → fund ${BUDGET_USDC} USDC`);
        await session.fund(AssetToken.usdc(BUDGET_USDC, CHAIN_ID));
      } else if (entry.event.type === 'job.completed') {
        box.terminal = { status: 'completed', reason: entry.event.reason };
        console.log(`[buyer]   job ${session.jobId} COMPLETED by evaluator: ${entry.event.reason}`);
        resolveTerminal();
      } else if (entry.event.type === 'job.rejected') {
        box.terminal = { status: 'rejected', reason: entry.event.reason };
        console.log(`[buyer]   job ${session.jobId} REJECTED by evaluator: ${entry.event.reason}`);
        resolveTerminal();
      }
    } catch (e) {
      console.error('[buyer]   error:', e instanceof Error ? e.message : e);
    }
  });

  await seller.start(() => console.log('[seller]  listening on Virtuals ACP (Base)'));
  await buyer.start(() => console.log('[buyer]   listening on Virtuals ACP (Base)'));

  const fromBlock = await publicClient.getBlockNumber();
  const expiredAt = Math.floor(Date.now() / 1000) + 3600;

  console.log(`\n[buyer]   creating job — service="${SERVICE_NAME}" provider=${sellerAddress} evaluator=${evaluatorAddress}`);
  const jobId = await buyer.createJob(CHAIN_ID, {
    providerAddress: sellerAddress,
    evaluatorAddress,
    expiredAt,
    description: buildJobDescription(),
  });
  console.log(`[buyer]   ✅ on-chain job id = ${jobId}\n`);

  await Promise.race([terminalReached, sleep(TIMEOUT_MS)]);

  // ── On-chain proof: scan the ACP contract's logs for this job's full lifecycle ──────────────────────
  console.log('\n── On-chain lifecycle (ACP contract logs) ─────────────────────────────');
  let onChainStatus = -1;
  try {
    const rawLogs = await publicClient.getLogs({ address: ACP_CONTRACT, fromBlock, toBlock: 'latest' });
    const decoded = parseEventLogs({ abi: ACP_ABI, logs: rawLogs })
      .filter((l) => (l.args as { jobId?: bigint }).jobId === jobId);
    for (const l of decoded) {
      console.log(`  ${l.eventName.padEnd(14)} tx=${l.transactionHash}`);
    }
    if (decoded.length === 0) console.log('  (no logs found yet — RPC may lag; check basescan for the job id)');
  } catch (e) {
    console.error('  log scan failed:', e instanceof Error ? e.message : e);
  }

  // Read the raw on-chain status straight from the contract (the JobCompleted/JobRejected log above is the
  // authoritative terminal proof; this is a secondary confirmation).
  try {
    const job = await buyer.getClient().getJob(CHAIN_ID, jobId);
    onChainStatus = job?.status ?? -1;
  } catch { /* best effort */ }

  const terminal = box.terminal;
  console.log('\n── Result ─────────────────────────────────────────────────────────────');
  console.log(`  job id:              ${jobId}`);
  console.log(`  terminal event:      ${terminal ? `${terminal.status} — ${terminal.reason}` : '(none within timeout)'}`);
  console.log(`  on-chain status enum:${onChainStatus === -1 ? ' unknown' : ' ' + onChainStatus}`);
  console.log(`  basescan (ACP core): https://basescan.org/address/${ACP_CONTRACT}`);

  await buyer.stop();
  await seller.stop();
  process.exit(terminal ? 0 : 1);
}

main().catch((e) => { console.error('[live-job] fatal:', e instanceof Error ? e.message : e); process.exit(1); });
