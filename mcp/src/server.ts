#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Verdikt, readEscrow, type Acceptance, type Artifact, type SignedTaskOffer } from '@verdikt/sdk';

// The agent operating this MCP server supplies ONE wallet via env. As a payer it calls create_task;
// as a seller it calls submit_artifact. Each agent runs its own server with its own key.
const PRIVATE_KEY = process.env.VERDIKT_PRIVATE_KEY as `0x${string}` | undefined;
const ENDPOINT = process.env.VERDIKT_ENDPOINT ?? 'https://verdikt-worker.fly.dev';
const RPC_URL = process.env.VERDIKT_RPC_URL;

function client(): Verdikt {
  if (!PRIVATE_KEY) throw new Error('VERDIKT_PRIVATE_KEY env var is required');
  return new Verdikt({ endpoint: ENDPOINT, rpcUrl: RPC_URL, signer: { privateKey: PRIVATE_KEY } });
}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: `ERROR: ${msg}` }], isError: true });

const server = new McpServer({ name: 'verdikt', version: '0.1.0' });

// PAYER: open a verified-payment job — register criteria, fund the escrow on-chain, return a signed
// Task Offer to hand the seller. Returns the offer as JSON the seller passes to submit_artifact.
server.registerTool('verdikt_create_task', {
  title: 'Create a verified-payment task',
  description: 'Payer side. Registers acceptance criteria, escrows USDC on Arc, and returns a signed Task Offer for a seller. Provide tests (code), schema (tool_output), or sources (answer) matching the type.',
  inputSchema: {
    type: z.enum(['code', 'tool_output', 'answer']),
    spec: z.string().describe('human description of "good"'),
    amountUsdc: z.number().positive(),
    seller: z.string().describe('seller agent wallet address (0x...)'),
    tests: z.string().optional().describe('code route: payer pytest file contents'),
    schema: z.record(z.any()).optional().describe('tool_output route: JSON schema fields'),
    minResponseBytes: z.number().optional(),
    sources: z.string().optional().describe('answer route: source text the answer must be grounded in'),
  },
}, async (a) => {
  try {
    const acceptance: Acceptance = { spec: a.spec, tests: a.tests, schema: a.schema as Acceptance['schema'], minResponseBytes: a.minResponseBytes, sources: a.sources };
    const r = await client().payer.createTask({ type: a.type, acceptance, amountUsdc: a.amountUsdc, seller: a.seller as `0x${string}` });
    return ok({ workId: r.workId, escrowTx: r.escrowTx, criteriaHash: r.criteriaHash, offer: r.offer });
  } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
});

// SELLER: deliver + get judged in one call. Verifies the offer + escrow on-chain, signs the
// artifact, pays the x402 fee, and returns the verdict. Fee captured only on release/refund.
server.registerTool('verdikt_submit_artifact', {
  title: 'Submit work for a verdict',
  description: 'Seller side. Takes a Task Offer (from create_task) and the delivered artifact; verifies the escrow, pays the sub-cent fee, and returns the verdict (released/refunded/abstained). Abstain is free.',
  inputSchema: {
    offer: z.string().describe('the SignedTaskOffer JSON returned by verdikt_create_task'),
    artifactType: z.enum(['code', 'tool_output', 'answer']),
    payload: z.string().describe('the delivered work (code source / JSON string / answer text)'),
    language: z.enum(['python', 'typescript']).optional(),
  },
}, async (a) => {
  try {
    const offer = JSON.parse(a.offer) as SignedTaskOffer;
    const artifact: Artifact = { type: a.artifactType, payload: a.payload, language: a.language };
    const result = await client().seller.submit({ offer, artifact });
    return ok(result);
  } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
});

// Inspect the on-chain escrow state for a workId (status/outcome/amount) — no wallet needed.
server.registerTool('verdikt_check_escrow', {
  title: 'Check an escrow on-chain',
  description: 'Reads the VerdiktEscrow state for a workId from Arc: status (1=funded,2=settled), outcome, amount, verdict code, evidence hash.',
  inputSchema: { escrow: z.string(), workId: z.string() },
}, async (a) => {
  try {
    const e = await readEscrow(a.escrow as `0x${string}`, a.workId as `0x${string}`, RPC_URL);
    return ok({ ...e, amount: e.amount.toString() });
  } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[verdikt-mcp] ready on stdio');
