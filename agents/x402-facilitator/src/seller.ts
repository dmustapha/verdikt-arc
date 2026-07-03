import express from 'express';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { HTTPFacilitatorClient } from '@x402/core/http';
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

// A REAL x402 reference seller settling on Arc through OUR self-hosted facilitator (Boundary #3). It is
// the other half of the x402 rail: the worker's x402 driver pays a sub-cent access TOLL to invoke it,
// and this seller VERIFIES + SETTLES that toll on-chain via the Verdikt facilitator (no public
// facilitator supports Arc) before doing the work. The BOUNTY never flows here — it stays escrow-gated
// on Arc and is released only by the verdict. x402 is discovery/transport; settlement is Verdikt's.
//
// Flow (matches the worker x402Driver): POST /research/dispatch
//   - no PAYMENT-SIGNATURE header  → 402 + PAYMENT-REQUIRED header (the toll challenge)
//   - PAYMENT-SIGNATURE present    → facilitator.verify → facilitator.settle (ON ARC) → 202 { jobUrl };
//                                    then do the Claude work async and serve it at the job URL.
//   GET /jobs/:id → { artifact } when ready, 404 while working.

const ARC_NETWORK = 'eip155:5042002' as const;
const ARC_USDC = '0x3600000000000000000000000000000000000000' as const;
const TOLL_ATOMIC = process.env.X402_TOLL_ATOMIC ?? '1000'; // $0.001 sub-cent access toll
const PAY_TO = (process.env.X402_SELLER_PAYTO ?? '0xB09336Db666810220288aD0b1246c59F0Bf5004f') as `0x${string}`;
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? 'https://verdikt-x402-facilitator.fly.dev';

const MODEL = process.env.REASONER_MODEL ?? 'claude-sonnet-4-6';
const SYSTEM = 'You are a careful research agent. Answer using ONLY the provided sources; every claim must be supported by them. If the sources do not cover the question, reply exactly: "The provided sources do not cover this question." Be concise.';

interface Brief { type: string; spec: string; sources?: string }
const jobs = new Map<string, { artifact: unknown } | 'working'>();

function paymentRequired(resourceUrl: string) {
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description: 'Verdikt x402 research seller — access toll', mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network: ARC_NETWORK, asset: ARC_USDC, amount: TOLL_ATOMIC, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2' } }],
  };
}

async function doResearch(brief: Brief): Promise<{ type: string; payload: string }> {
  const client = new Anthropic();
  const sources = brief.sources?.trim() || '(no sources were provided)';
  const r = await client.messages.create({ model: MODEL, max_tokens: 1500, system: SYSTEM, messages: [{ role: 'user', content: `Sources:\n${sources}\n\nQuestion:\n${brief.spec}\n\nAnswer using ONLY the sources above.` }] });
  const answer = r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { type: 'answer', payload: answer };
}

export function buildSellerApp(): express.Express {
  // Authenticate to our facilitator on the money-touching methods (verify/settle). The key is shared
  // out-of-band (Fly secret on both apps); an unauthenticated caller gets 401 and cannot spend the
  // settler's gas. /supported stays keyless (public discovery).
  const key = process.env.X402_FACILITATOR_SECRET;
  const authHeaders: Record<string, string> = key ? { 'x-facilitator-key': key } : {};
  const facilitator = new HTTPFacilitatorClient({
    url: FACILITATOR_URL,
    createAuthHeaders: async () => ({ verify: authHeaders, settle: authHeaders, supported: {} }),
  });
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'verdikt-x402-seller', facilitator: FACILITATOR_URL, network: ARC_NETWORK }));

  app.post('/research/dispatch', async (req, res) => {
    const resourceUrl = `${baseUrl(req)}/research/dispatch`;
    const sig = req.get('payment-signature');
    if (!sig) { res.status(402).set('PAYMENT-REQUIRED', encodePaymentRequiredHeader(paymentRequired(resourceUrl))).end(); return; }

    // A toll was tendered — VERIFY then SETTLE it on Arc via our facilitator before doing any work.
    let payload: PaymentPayload;
    try { payload = decodePaymentSignatureHeader(sig); }
    catch { res.status(400).json({ error: 'malformed PAYMENT-SIGNATURE' }); return; }
    const requirements = paymentRequired(resourceUrl).accepts[0] as unknown as PaymentRequirements;

    const verified = await facilitator.verify(payload, requirements).catch((e) => ({ isValid: false, invalidReason: String(e) }));
    if (!verified.isValid) { res.status(402).set('PAYMENT-REQUIRED', encodePaymentRequiredHeader(paymentRequired(resourceUrl))).json({ error: 'toll not valid', reason: verified.invalidReason }); return; }
    const settled = await facilitator.settle(payload, requirements).catch((e) => ({ success: false, errorMessage: String(e) }));
    if (!settled.success) { res.status(402).json({ error: 'toll settlement failed', reason: (settled as { errorMessage?: string }).errorMessage }); return; }

    // Toll settled on Arc. Ack async (202 + job URL the worker polls); do the work off the request.
    const brief = (req.body?.brief ?? null) as Brief | null;
    const jobId = randomUUID();
    jobs.set(jobId, 'working');
    res.status(202).json({ jobUrl: `${baseUrl(req)}/jobs/${jobId}`, tollTx: (settled as { transaction?: string }).transaction });

    void (async () => {
      try { if (!brief) throw new Error('no brief'); jobs.set(jobId, { artifact: await doResearch(brief) }); }
      catch { jobs.delete(jobId); } // job no-shows → buyer refunded
    })();
  });

  app.get('/jobs/:id', (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j || j === 'working') { res.status(404).json({ status: 'working' }); return; }
    res.status(200).json({ artifact: j.artifact });
  });

  return app;
}

function baseUrl(req: express.Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
  return `${proto}://${req.get('host')}`;
}

if (process.argv[1] && process.argv[1].endsWith('seller.ts')) {
  const port = Number(process.env.PORT ?? 8082);
  buildSellerApp().listen(port, () => console.log(`[x402-seller] listening on :${port} (facilitator ${FACILITATOR_URL})`));
}
