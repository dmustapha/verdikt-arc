import { describe, it, expect } from 'vitest';
import { decodeAbiParameters } from 'viem';
import { addressToBytes32, encodeHookData } from '../src/crosschain.js';

// These lock the cross-language seam: encodeHookData MUST be byte-identical to Solidity
// abi.encode(bytes32, address, address, uint256, uint256, uint32, bytes32, uint32, bytes32) so the
// Arc hook's abi.decode(message[376:], (...9 types...)) recovers exactly
//   {workId, payer, worker, fee, ttl, workerDomain, workerRecipient, payerDomain, payerRecipient}.
// If this drifts, cross-chain funding decodes garbage. (v3 layout adds the verdict fee + no-show ttl.)

const workId = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const payer = '0x00000000000000000000000000000000000000A1' as const;
const worker = '0x00000000000000000000000000000000000000B0' as const;

// The 9-field v3 decode tuple, matching EscrowFundingHook.mintAndFund.
const HOOK_DATA_TUPLE = [
  { type: 'bytes32' }, { type: 'address' }, { type: 'address' },
  { type: 'uint256' }, { type: 'uint256' },
  { type: 'uint32' }, { type: 'bytes32' }, { type: 'uint32' }, { type: 'bytes32' },
] as const;

describe('cross-chain hookData encoding (v3)', () => {
  it('encodes exactly 288 bytes (9 * 32) for abi.decode', () => {
    const hex = encodeHookData(workId, payer, worker, 0n, 604800n);
    expect((hex.length - 2) / 2).toBe(288);
  });

  it('round-trips through abi.decode (mirrors the Solidity hook decode, local routes)', () => {
    const hex = encodeHookData(workId, payer, worker, 0n, 604800n);
    const [id, p, w, fee, ttl, wDom, , pDom] = decodeAbiParameters(HOOK_DATA_TUPLE, hex);
    expect(id).toBe(workId);
    expect((p as string).toLowerCase()).toBe(payer.toLowerCase());
    expect((w as string).toLowerCase()).toBe(worker.toLowerCase());
    expect(fee).toBe(0n);
    expect(ttl).toBe(604800n);
    expect(Number(wDom)).toBe(0); // local
    expect(Number(pDom)).toBe(0);
  });

  it('carries a verdict fee + custom ttl through the bridge', () => {
    const hex = encodeHookData(workId, payer, worker, 1_000000n, 172800n);
    const [, , , fee, ttl] = decodeAbiParameters(HOOK_DATA_TUPLE, hex);
    expect(fee).toBe(1_000000n);
    expect(ttl).toBe(172800n);
  });

  it('encodes cross-chain payout routes (seller on Base domain 6)', () => {
    const sellerOnBase = '0x000000000000000000000000000000000000bA5E' as const;
    const hex = encodeHookData(workId, payer, worker, 0n, 604800n, { worker: { domain: 6, recipient: sellerOnBase } });
    const [, , , , , wDom, wRcpt] = decodeAbiParameters(HOOK_DATA_TUPLE, hex);
    expect(Number(wDom)).toBe(6);
    expect((wRcpt as string).toLowerCase().endsWith('ba5e')).toBe(true);
  });

  it('left-pads an address to a 32-byte CCTP recipient', () => {
    const b32 = addressToBytes32(payer);
    expect(b32.toLowerCase()).toBe('0x00000000000000000000000000000000000000000000000000000000000000a1');
    expect((b32.length - 2) / 2).toBe(32);
  });
});
