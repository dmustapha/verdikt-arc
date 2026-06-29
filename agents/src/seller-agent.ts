import type { Artifact, ArtifactType, SignedTaskOffer, VerdictResult, VerdictStep } from '@verdikt/sdk';
import { Agent } from './agent.js';
import type { ToolSpec } from './brain.js';

// The seller/provider agent. It receives a Task Offer + a brief, REASONS + GENERATES the deliverable,
// onboards onto Gateway (so it can pay the sub-cent verdict fee), and submits. It is independent: it
// trusts the signed offer + the on-chain escrow, and never sees the payer's exact tests.
const DELIVER_TOOL: ToolSpec = {
  name: 'deliver_work',
  description: 'Produce the work artifact that satisfies the brief.',
  input_schema: {
    type: 'object',
    properties: {
      payload: { type: 'string', description: 'the deliverable itself: complete code source / a JSON string / the answer text. For code, output ONLY the module (it is saved as solution.py).' },
      language: { type: 'string', enum: ['python', 'typescript'], description: 'code route only' },
      note: { type: 'string', description: 'one line on your approach (not submitted)' },
    },
    required: ['payload'],
  },
};

// A seller's working style. `diligent` does the job well; `hasty` ships the minimal thing that looks
// done — a real failure mode Verdikt exists to catch (e.g. unparameterized SQL → security finding).
export type SellerStyle = 'diligent' | 'hasty';

const STYLE_SYSTEM: Record<SellerStyle, string> = {
  diligent: 'You are a careful seller/provider agent. Produce a correct, secure deliverable that fully satisfies the brief. For code, match any exact names the brief specifies and handle the stated requirements.',
  hasty: 'You are a seller/provider agent under heavy time pressure. Ship the smallest, simplest implementation that covers the MAIN case — ideally a single expression or one or two lines. Favor brevity over robustness: do NOT add guards, edge-case handling, input validation, or defensive checks. Implement only the obvious happy path.',
};

export interface Delivery { payload: string; language?: 'python' | 'typescript'; note?: string; }

export class SellerAgent extends Agent {
  constructor(endpoint: string, rpcUrl: string | undefined, key: `0x${string}`) {
    super('seller', endpoint, rpcUrl, key);
  }

  /** Ensure the seller can pay verdict fees from its Gateway balance (idempotent). */
  async onboard() { return this.vk.seller.ensureOnboarded({ minUsdc: 0.002, depositUsdc: 0.02 }); }

  /** Generate the deliverable with the LLM, then submit it for a verdict. `onStep` narrates the live
   *  verdict steps (the same SSE the courtroom watches). */
  async fulfill(offer: SignedTaskOffer, route: ArtifactType, sellerBrief: string, style: SellerStyle = 'diligent', onStep?: (s: VerdictStep) => void): Promise<{ delivery: Delivery; result: VerdictResult }> {
    const delivery = await this.brain.decide<Delivery>(
      STYLE_SYSTEM[style],
      `Route: ${route}\nBrief: ${sellerBrief}\n\nProduce the deliverable now.`,
      DELIVER_TOOL,
    );
    const artifact: Artifact = route === 'code'
      ? { type: 'code', language: delivery.language ?? 'python', payload: delivery.payload }
      : { type: route, payload: delivery.payload };
    // Independent seller: verify the offer + escrow on-chain, sign the artifact, pay x402, await verdict.
    const result = await this.vk.seller.submit({ offer, artifact, onStep });
    return { delivery, result };
  }
}
