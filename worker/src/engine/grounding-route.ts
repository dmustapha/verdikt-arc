import Anthropic from '@anthropic-ai/sdk';
import type { Acceptance, Artifact, EvidenceBundle, EvidenceItem } from '../types.js';

const MODEL = process.env.GROUNDING_MODEL ?? 'claude-sonnet-4-6';

const CLAIM_TOOL = {
  name: 'report_grounding',
  description: 'Report whether the answer\'s key claim is supported by a verbatim span in the provided sources.',
  input_schema: {
    type: 'object' as const,
    properties: {
      key_claim: { type: 'string', description: 'the single load-bearing claim in the answer' },
      label: { type: 'string', enum: ['supported', 'unsupported', 'uncertain'] },
      supporting_span: { type: 'string', description: 'verbatim substring copied from the sources, or empty' },
    },
    required: ['key_claim', 'label', 'supporting_span'],
  },
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export async function runGroundingRoute(acceptance: Acceptance, artifact: Artifact): Promise<EvidenceBundle> {
  if (!acceptance.sources || acceptance.sources.trim() === '') {
    return { route: 'answer', items: [], routeError: 'payer provided no sources' };
  }

  // See reasoner.ts: route through global fetch to avoid the SDK's "Premature close" on Fly.
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, fetch: (...a) => globalThis.fetch(...a) });

  let toolInput: { key_claim: string; label: string; supporting_span: string };
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      tool_choice: { type: 'tool', name: 'report_grounding' },
      tools: [CLAIM_TOOL],
      messages: [{
        role: 'user',
        content:
          `SOURCES (the only ground truth):\n${acceptance.sources}\n\n` +
          `ANSWER to verify:\n${artifact.payload}\n\n` +
          `Find the answer's single key claim. Copy a verbatim supporting span from SOURCES if one exists. ` +
          `If no verbatim span supports it, label unsupported. If you are unsure, label uncertain. Do not invent spans.`,
      }],
    });
    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      return { route: 'answer', items: [], routeError: 'grounding model returned no structured result' };
    }
    toolInput = block.input as typeof toolInput;
  } catch (err) {
    return { route: 'answer', items: [], routeError: `grounding API error: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Post-match: the cited span must actually appear in the sources, else treat as unsupported.
  const spanInSource =
    toolInput.supporting_span.length > 0 &&
    normalize(acceptance.sources).includes(normalize(toolInput.supporting_span));

  const verified = toolInput.label === 'supported' && spanInSource;
  const items: EvidenceItem[] = [{
    id: 'span:key_claim',
    kind: 'span',
    label: 'key claim grounding',
    status: verified ? 'pass' : toolInput.label === 'uncertain' || !spanInSource ? 'info' : 'fail',
    detail:
      `claim: "${toolInput.key_claim.slice(0, 160)}" — label=${toolInput.label}` +
      `, span ${spanInSource ? 'matched in sources' : 'NOT found in sources'}`,
    ref: spanInSource ? toolInput.supporting_span.slice(0, 160) : undefined,
  }];

  // If the model was uncertain or the span did not verify, signal abstain to the reasoner.
  const routeError =
    !verified && (toolInput.label === 'uncertain' || !spanInSource)
      ? 'claim not verifiably supported by provided sources'
      : undefined;

  return { route: 'answer', items, routeError };
}
