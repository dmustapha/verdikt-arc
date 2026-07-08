// Phase 1 — Verdikt as a WALK-UP paid service on the x402 Bazaar (Coinbase CDP facilitator, Base mainnet).
//
// Any agent can discover + pay + call Verdikt with no permission and no counterparty: a standard HTTP 402
// handshake settles a $0.05 USDC fee on Base (eip155:8453) via the CDP facilitator (which fronts gas), then
// the request runs Verdikt's verdict engine — the SAME `evaluateDeliverable` brain behind /api/evaluate and
// the ACP evaluator. Declaring a Bazaar discovery extension makes the CDP facilitator index this endpoint in
// its public catalog, so Bazaar MCP clients crawl and call it automatically. One engine, a second front door.
//
// Feature-flagged: mounts ONLY when the CDP keys + payTo are configured (worker/.env or Fly secrets), so
// every other environment (local dev without CDP keys, etc.) is unaffected.
import { Router, type Request, type Response } from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { withBazaar, declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { facilitator } from '@coinbase/x402';
import { evaluateDeliverable } from './evaluate.js';

const BASE_MAINNET = 'eip155:8453' as const;
const PRICE = process.env.X402_VERIFY_PRICE ?? '$0.05';
const ROUTE_ENUM = ['code', 'tool_output', 'answer', 'execution', 'tool_trace'];

// The public shape a Bazaar crawler sees: what to POST and an example of what comes back.
const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    route: { type: 'string', enum: ROUTE_ENUM, description: 'which verdict route to grade against' },
    acceptance: { type: 'object', description: 'the acceptance criteria for the route (e.g. jsonSchema, tests, sources, execution, toolTrace)' },
    artifact: {
      type: 'object',
      properties: { payload: { type: 'string' }, language: { type: 'string' } },
      required: ['payload'],
      description: 'the deliverable to judge; payload is the artifact string',
    },
  },
  required: ['route', 'acceptance', 'artifact'],
};
const OUTPUT_EXAMPLE = { verdict: 'pass', approve: true, score: 100, confidence: 1, rationale: 'deliverable meets acceptance', evidenceHash: '0x…' };
// A concrete request example — the bazaar validator checks this against INPUT_SCHEMA, so it must satisfy it.
const INPUT_EXAMPLE = {
  route: 'tool_output',
  acceptance: { jsonSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } },
  artifact: { payload: '{"ok":true}' },
};

// Build the CDP-backed, Bazaar-enabled resource server. Kept lazy inside the factory so importing this module
// never touches CDP env unless the feature is actually mounted.
function buildServer(): x402ResourceServer {
  const facilitatorClient = withBazaar(new HTTPFacilitatorClient(facilitator));
  return new x402ResourceServer(facilitatorClient).register(BASE_MAINNET, new ExactEvmScheme());
}

export function makeX402BazaarRouter(): Router {
  const r = Router();
  const payTo = process.env.VERDIKT_PAYTO;
  const hasCdp = !!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
  if (!payTo || !hasCdp) {
    console.warn('[x402-bazaar] disabled — set CDP_API_KEY_ID, CDP_API_KEY_SECRET, and VERDIKT_PAYTO to enable the Base-mainnet paid endpoint.');
    return r;
  }

  const routes = {
    'POST /x402/verify': {
      accepts: { scheme: 'exact', price: PRICE, network: BASE_MAINNET, payTo },
      description: 'Verdikt renders an evidence-anchored verdict over an agent deliverable across five routes (code, tool_output, answer, execution, tool_trace) and never false-certifies.',
      mimeType: 'application/json',
      serviceName: 'Verdikt deliverable verification',
      tags: ['verification', 'evaluation', 'agents', 'verdict'],
      // The HTTP method is inferred from the route key ("POST ...") — the config omits it by design.
      extensions: declareDiscoveryExtension({
        bodyType: 'json',
        input: INPUT_EXAMPLE,
        inputSchema: INPUT_SCHEMA,
        output: { example: OUTPUT_EXAMPLE },
      }),
    },
  };

  r.use(paymentMiddleware(routes, buildServer()));

  // Runs only AFTER the x402 fee is verified; the middleware settles on the way out.
  r.post('/x402/verify', async (req: Request, res: Response) => {
    const { status, payload } = await evaluateDeliverable((req.body ?? {}) as Record<string, unknown>);
    res.status(status).json(payload);
  });

  console.log(`[x402-bazaar] LIVE — POST /x402/verify (${PRICE} on Base mainnet, payTo ${payTo})`);
  return r;
}
