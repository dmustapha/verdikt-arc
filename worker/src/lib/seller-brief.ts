import type { Task, SellerBrief } from '../types.js';

// Project a funded Task onto the SELLER-FACING brief that rides in the dispatch envelope (Option C).
// This is the ONE place that decides what a seller may see: the input it needs to produce the
// deliverable, and nothing the payer intends to keep as a hidden verification criterion. The payer's
// full `acceptance` still governs the verdict — the brief is never a criterion, only an input.
//
// Route rules:
//  - answer:      the question (spec) + the `sources` to ground in.
//  - tool_output: the target `schema` / `jsonSchema` to produce.
//  - code:        the failing `tests` to make pass — BUT only in "fair mode". If the payer set an
//                 informal `sellerBrief`, they are deliberately briefing loosely and the exact tests
//                 stay hidden (the honest seller-gap: the seller builds to the ask, the strict suite
//                 still governs the money).
//  - execution / tool_trace: spec-only (reference sellers don't target these; they carry no seller input).
export function buildSellerBrief(task: Task): SellerBrief {
  const a = task.acceptance;
  const informal = typeof a.sellerBrief === 'string' && a.sellerBrief.trim() !== '';
  const brief: SellerBrief = { type: task.type, spec: informal ? a.sellerBrief!.trim() : a.spec };

  switch (task.type) {
    case 'answer':
      if (a.sources) brief.sources = a.sources;
      break;
    case 'tool_output':
      if (a.schema) brief.schema = a.schema;
      if (a.jsonSchema) brief.jsonSchema = a.jsonSchema;
      break;
    case 'code':
      // Fair mode only — an informal brief keeps the exact tests hidden.
      if (!informal && a.tests) brief.tests = a.tests;
      break;
    default:
      break; // execution / tool_trace: spec is the whole brief
  }
  return brief;
}
