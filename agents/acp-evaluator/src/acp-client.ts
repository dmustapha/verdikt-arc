// WS12 — the LIVE Verdikt ACP evaluator agent. Connects the registered Verdikt agent to Virtuals ACP
// (Base mainnet) and, whenever a job it is the evaluator on submits a deliverable, judges it with
// Verdikt's verdict engine (via evaluateSubmitted → /api/evaluate) and settles the ACP job with
// session.complete()/reject(). Wiring mirrors the official v2 seller example; the evaluator differs only
// in acting on `job.submitted` for jobs where we are the evaluatorAddress.
//
// Run (needs the signer key in agents/acp-evaluator/.env):
//   set -a; . agents/acp-evaluator/.env; set +a; npx tsx agents/acp-evaluator/src/acp-client.ts
import { AcpAgent, PrivyAlchemyEvmProviderAdapter } from '@virtuals-protocol/acp-node-v2';
import type { JobSession, JobRoomEntry } from '@virtuals-protocol/acp-node-v2';
import { base } from 'viem/chains';
import { evaluateSubmitted } from './judge.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see agents/acp-evaluator/.env.example)`);
  return v;
}

// Pull the acceptance JSON Schema for the structured-data service off the job. The buyer embeds the service
// contract in the ACP job `description` as JSON — `{ service, schema, prompt }` — so the schema Verdikt
// judges against is the job's own on-chain contract, not a private constant. Kept lenient: a description
// that is already the bare schema, or nests it under `jsonSchema`, also resolves.
function extractSchema(job: JobSession['job']): Record<string, unknown> | null {
  const description = job?.description;
  if (typeof description !== 'string' || !description.trim()) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(description) as Record<string, unknown>; } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const schema = (obj.schema ?? obj.jsonSchema ?? (obj.type ? obj : null)) as Record<string, unknown> | null;
  return schema && typeof schema === 'object' ? schema : null;
}

async function main(): Promise<void> {
  const evaluatorAddress = requireEnv('ACP_WALLET_ADDRESS').toLowerCase();
  const agent = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: requireEnv('ACP_WALLET_ADDRESS') as `0x${string}`,
      walletId: requireEnv('ACP_WALLET_ID'),
      signerPrivateKey: requireEnv('ACP_SIGNER_PRIVATE_KEY'),
      chains: [base],
    }),
  });

  agent.on('entry', async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind !== 'system' || entry.event.type !== 'job.submitted') return;
    const job = session.job;
    // Only judge jobs where Verdikt is the named evaluator (third-party evaluation).
    if (!job || job.evaluatorAddress.toLowerCase() !== evaluatorAddress) return;

    const schema = extractSchema(job);
    if (!schema) {
      console.warn(`[verdikt-acp] [job ${session.jobId}] no JSON Schema in the requirement — rejecting (unverifiable)`);
      await session.reject('Verdikt: this evaluator verifies structured data; the job carried no JSON Schema to check against.');
      return;
    }

    // The job.submitted event carries the deliverable string directly (guaranteed present); fall back to the
    // freshly-fetched job if ever absent.
    const deliverable = entry.event.deliverable ?? job.deliverable;
    console.log(`[verdikt-acp] [job ${session.jobId}] deliverable submitted — judging with Verdikt…`);
    try {
      const r = await evaluateSubmitted({ deliverable, jsonSchema: schema }, session);
      console.log(`[verdikt-acp] [job ${session.jobId}] verdict=${r.verdict} → ${r.approve ? 'COMPLETE' : 'REJECT'} (${r.reason.slice(0, 80)})`);
    } catch (e) {
      console.error(`[verdikt-acp] [job ${session.jobId}] evaluation error — rejecting to be safe:`, e instanceof Error ? e.message : e);
      await session.reject('Verdikt: evaluation could not be completed; rejecting rather than releasing on unverified work.');
    }
  });

  await agent.start(() => console.log(`[verdikt-acp] Verdikt evaluator LIVE on Virtuals ACP (Base) as ${evaluatorAddress}`));
}

main().catch((e) => { console.error('[verdikt-acp] fatal:', e instanceof Error ? e.message : e); process.exit(1); });
