import type { Acceptance, ArtifactType, SignedTaskOffer } from '@verdikt/sdk';
import { Agent } from './agent.js';
import type { ToolSpec } from './brain.js';

// The buyer agent. Given a plain-language goal, it REASONS OUT machine-checkable acceptance criteria
// (the heart of Verdikt — "garbage criteria in, garbage verdict out"), funds the escrow, and signs a
// Task Offer for an independent seller. It never does the work; it defines what "done" means.
const COMMISSION_TOOL: ToolSpec = {
  name: 'commission_task',
  description: 'Turn a goal into a verifiable Verdikt task: pick the route, write the payer ground truth a machine can check, and a brief for the seller.',
  input_schema: {
    type: 'object',
    properties: {
      route: { type: 'string', enum: ['code', 'tool_output', 'answer'], description: 'code=runnable+tests, tool_output=JSON+schema, answer=text+sources' },
      spec: { type: 'string', description: 'one-line description of "good"' },
      tests: { type: 'string', description: 'code route ONLY: a complete Python pytest file that does `from solution import <fn>` and asserts the requirement. Name the function explicitly.' },
      schema: { type: 'object', description: 'tool_output route ONLY: a field map, e.g. {"price":{"type":"number","required":true,"min":0}}' },
      sources: { type: 'string', description: 'answer route ONLY: the ground-truth text the answer must be supported by (verbatim).' },
      sellerBrief: { type: 'string', description: 'plain-language instructions to hand the seller — enough to do the job, including any exact names the tests rely on.' },
    },
    required: ['route', 'spec', 'sellerBrief'],
  },
};

interface Commission {
  route: ArtifactType; spec: string; tests?: string; schema?: Record<string, unknown>; sources?: string; sellerBrief: string;
}

export interface CommissionResult {
  workId: `0x${string}`; offer: SignedTaskOffer; escrowTx: `0x${string}`;
  route: ArtifactType; acceptance: Acceptance; sellerBrief: string;
}

export class PayerAgent extends Agent {
  constructor(endpoint: string, rpcUrl: string | undefined, key: `0x${string}`) {
    super('payer', endpoint, rpcUrl, key);
  }

  // Reason a goal into criteria + fund the escrow + sign the offer. `fixedSources` lets the caller
  // pin the payer's own source material (a real payer brings its evidence; we don't fabricate it).
  async commission(goal: string, seller: `0x${string}`, amountUsdc: number, fixedSources?: string): Promise<CommissionResult> {
    const plan = await this.brain.decide<Commission>(
      'You are a buyer agent that commissions verifiable work between autonomous agents. You DEFINE acceptance criteria a machine can check — never subjective "looks good". For code, write a real pytest that imports `solution`. For tool_output, a JSON field map. For answer, the answer must be grounded in the sources you supply. Keep the seller brief consistent with the criteria (same function names, same fields).',
      `Goal: ${goal}${fixedSources ? `\n\nUse EXACTLY these sources (do not invent others):\n${fixedSources}` : ''}\n\nCommission the task.`,
      COMMISSION_TOOL,
    );

    const acceptance: Acceptance = { spec: plan.spec };
    if (plan.route === 'code') acceptance.tests = plan.tests;
    else if (plan.route === 'tool_output') acceptance.schema = plan.schema as Acceptance['schema'];
    else acceptance.sources = fixedSources ?? plan.sources;

    const { workId, offer, escrowTx } = await this.vk.payer.createTask({
      type: plan.route, acceptance, amountUsdc, seller,
    });
    return { workId, offer, escrowTx, route: plan.route, acceptance, sellerBrief: plan.sellerBrief };
  }
}
