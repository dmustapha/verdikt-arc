import type { SellerSkill } from '../lib/seller.js';
import type { Brain } from '../lib/brain.js';
import { stripFences } from '../lib/text.js';

// Reference seller #3 — Code / PR. Input: a failing test + the task (in "fair mode" the seller sees the
// test it must make pass). Output: a Python module the worker runs against the payer's pytest in a
// sandbox (the `code` route). Honesty is enforced by execution: the code only earns a release if the
// tests actually pass — a plausible-but-wrong implementation fails and the buyer is refunded. The agent
// is told to match the exact names the test imports and handle the edge cases the test exercises.

const SYSTEM = [
  'You are a careful software engineer. Write a COMPLETE, correct Python module that makes the provided',
  'failing test pass. Output ONLY the Python source of the module — no prose, no explanation, no markdown',
  'fences. The module is saved as solution.py and imported by the test, so match the EXACT function and',
  'class names the test uses, and handle every edge case the test exercises (empty inputs, boundaries, etc).',
].join(' ');

export function codeSkill(brain: Brain): SellerSkill {
  return {
    id: 'code',
    name: 'Code / PR',
    description: 'Writes a Python module that makes a failing test pass',
    route: 'code',
    tags: ['code', 'python', 'tdd', 'fix'],
    capability: 'code-fix',
    acceptanceTemplate: {
      spec: 'Write code that makes the provided pytest pass; the test suite governs payment.',
      inputLabel: 'A failing pytest + a description of the function/module to implement',
    },
    async doWork(brief) {
      const test = brief.tests?.trim() || '(no failing test was provided)';
      const src = await brain.say(
        SYSTEM,
        `Failing test (the seller must make it pass):\n${test}\n\nTask:\n${brief.spec}\n\nWrite solution.py now.`,
        2500,
      );
      return { type: 'code', payload: stripFences(src), language: 'python' };
    },
  };
}
