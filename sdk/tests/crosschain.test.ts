import { describe, it, expect } from 'vitest';
import { decodeAbiParameters } from 'viem';
import { addressToBytes32, encodeHookData } from '../src/crosschain.js';

// These lock the cross-language seam: encodeHookData MUST be byte-identical to Solidity
// abi.encode(bytes32, address, address) so the Arc hook's
//   abi.decode(message[376:], (bytes32, address, address))
// recovers exactly {workId, payer, worker}. If this drifts, cross-chain funding decodes garbage.

const workId = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const payer = '0x00000000000000000000000000000000000000A1' as const;
const worker = '0x00000000000000000000000000000000000000B0' as const;

describe('cross-chain hookData encoding', () => {
  it('encodes exactly 96 bytes (3 * 32) for abi.decode', () => {
    const hex = encodeHookData(workId, payer, worker);
    expect((hex.length - 2) / 2).toBe(96);
  });

  it('round-trips through abi.decode (mirrors the Solidity hook decode)', () => {
    const hex = encodeHookData(workId, payer, worker);
    const [id, p, w] = decodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }],
      hex,
    );
    expect(id).toBe(workId);
    expect((p as string).toLowerCase()).toBe(payer.toLowerCase());
    expect((w as string).toLowerCase()).toBe(worker.toLowerCase());
  });

  it('left-pads an address to a 32-byte CCTP recipient', () => {
    const b32 = addressToBytes32(payer);
    expect(b32.toLowerCase()).toBe('0x00000000000000000000000000000000000000000000000000000000000000a1');
    expect((b32.length - 2) / 2).toBe(32);
  });
});
