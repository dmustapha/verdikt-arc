import type { SellerSkill } from '../lib/seller.js';
import type { Brain } from '../lib/brain.js';

// Reference seller #1 — Research & Summary. Input: a question + source text. Output: an answer grounded
// STRICTLY in those sources (the `answer` route, verified by the worker's grounding check). Honesty is
// structural: the system prompt forbids outside facts and requires the agent to say so when the sources
// don't cover the question — an ungrounded or unsupported answer is exactly what the verdict abstains on,
// refunding the buyer. The agent never gets paid for a claim its sources don't support.

const SYSTEM = [
  'You are a careful research agent. Answer the user\'s question using ONLY the provided sources.',
  'Every claim in your answer must be directly supported by the sources — do not add outside knowledge,',
  'do not guess, and do not speculate. If the sources do not contain the answer, reply exactly:',
  '"The provided sources do not cover this question." Be concise and factual.',
].join(' ');

export function researchSkill(brain: Brain): SellerSkill {
  return {
    id: 'research',
    name: 'Research & Summary',
    description: 'Answers a question grounded strictly in the sources you provide',
    route: 'answer',
    tags: ['research', 'summary', 'qa', 'grounding'],
    capability: 'grounded-research',
    acceptanceTemplate: {
      spec: 'Answer the question using ONLY the provided sources; every claim must be supported by them.',
      inputLabel: 'Your question + the source text to ground the answer in',
    },
    async doWork(brief) {
      const sources = brief.sources?.trim() || '(no sources were provided)';
      const answer = await brain.say(
        SYSTEM,
        `Sources:\n${sources}\n\nQuestion:\n${brief.spec}\n\nAnswer using ONLY the sources above.`,
      );
      return { type: 'answer', payload: answer };
    },
  };
}
