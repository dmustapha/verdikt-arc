import { describe, it, expect } from 'vitest';
import { keccak256, toBytes, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { outcomeFor } from '../../src/settlement/settle.js';
import { buildReceipt } from '../../src/lib/receipt.js';
import type { VerdictResult, Settlement } from '../../src/types.js';

// A throwaway, well-known test key (NOT the real signer). Used only to verify the
// receipt signature is recoverable to the signing account — no network, pure crypto.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

function verdict(label: VerdictResult['verdict']): VerdictResult {
  return {
    verdict: label,
    verdictCode: { pass: 0, fail: 1, partial: 2, abstain: 3 }[label],
    evidenceHash: ('0x' + '11'.repeat(32)) as `0x${string}`,
    confidence: 1,
    citedEvidence: [],
    rationale: '',
    route: 'code',
  };
}

// WS2: partial now settles as a real split (settlePartial), so its off-chain outcome is 'partial'
// (on-chain outcome enum 3), NOT a refund. The confidence 1 fixture → score 100 → bps clamped 9999.
describe('outcomeFor', () => {
  it('pass → release', () => expect(outcomeFor(verdict('pass'))).toBe('release'));
  it('fail → refund', () => expect(outcomeFor(verdict('fail'))).toBe('refund'));
  it('partial → partial (real split, never a full refund)', () => expect(outcomeFor(verdict('partial'))).toBe('partial'));
  it('abstain → abstain', () => expect(outcomeFor(verdict('abstain'))).toBe('abstain'));
});

describe('buildReceipt', () => {
  it('produces a signature recoverable to the configured signer', async () => {
    process.env.RECEIPT_SIGNER_KEY = TEST_KEY;
    const account = privateKeyToAccount(TEST_KEY);
    const v = verdict('pass');
    const settlement: Settlement = {
      workId: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
      outcome: 'release',
      verdictCode: v.verdictCode,
      evidenceHash: v.evidenceHash,
      txHash: '0xdeadbeef',
      circleTxId: 'test-tx-id',
    };

    const receipt = await buildReceipt(settlement, v, 1);

    // Reconstruct the exact digest the receipt was signed over.
    const unsigned = {
      workId: settlement.workId,
      verdict: v.verdict,
      verdictCode: v.verdictCode,
      outcome: settlement.outcome,
      evidenceHash: v.evidenceHash,
      amountUsdc: 1,
      txHash: settlement.txHash,
    };
    const digest = keccak256(toBytes(JSON.stringify(unsigned)));

    const recovered = await recoverMessageAddress({ message: { raw: digest }, signature: receipt.signature });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    expect(receipt.outcome).toBe('release');
    expect(receipt.evidenceHash).toBe(v.evidenceHash);
    expect(receipt.amountUsdc).toBe(1);
  });
});
