import { describe, it, expect } from 'vitest';
import { encodeFunctionData, decodeFunctionData } from 'viem';
import { validationRequestCall, validationResponseCall } from '../../src/lib/erc8004-writer.js';
import { ERC8004_VALIDATION_REGISTRY } from '../../src/lib/erc8004-constants.js';

const REQ_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const RES_HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
const VALIDATOR = '0xD089Dfc911ea0A5cA7A54ff912ab73B5531D02D7' as `0x${string}`;

describe('validationRequestCall', () => {
  it('encodes with the exact arg order/types (validator, agentId, requestURI, requestHash)', () => {
    const call = validationRequestCall({ validator: VALIDATOR, agentId: 7n, requestURI: 'https://x/e.json', requestHash: REQ_HASH });
    expect(call.address).toBe(ERC8004_VALIDATION_REGISTRY);
    const data = encodeFunctionData(call as any);
    const decoded = decodeFunctionData({ abi: call.abi, data });
    expect(decoded.functionName).toBe('validationRequest');
    expect(decoded.args).toEqual([VALIDATOR, 7n, 'https://x/e.json', REQ_HASH]);
  });
});

describe('validationResponseCall', () => {
  it('encodes with the exact arg order/types (requestHash, response, responseURI, responseHash, tag)', () => {
    const call = validationResponseCall({ requestHash: REQ_HASH, response: 88, responseURI: 'https://x/e.json', responseHash: RES_HASH, tag: 'verdikt:release' });
    const data = encodeFunctionData(call as any);
    const decoded = decodeFunctionData({ abi: call.abi, data });
    expect(decoded.functionName).toBe('validationResponse');
    expect(decoded.args).toEqual([REQ_HASH, 88, 'https://x/e.json', RES_HASH, 'verdikt:release']);
  });

  it('rejects an out-of-range response BEFORE it can hit the chain (contract requires <=100)', () => {
    expect(() => validationResponseCall({ requestHash: REQ_HASH, response: 101, responseURI: 'u', responseHash: RES_HASH, tag: 't' })).toThrow(/0\.\.100/);
    expect(() => validationResponseCall({ requestHash: REQ_HASH, response: -1, responseURI: 'u', responseHash: RES_HASH, tag: 't' })).toThrow(/0\.\.100/);
    expect(() => validationResponseCall({ requestHash: REQ_HASH, response: 3.5, responseURI: 'u', responseHash: RES_HASH, tag: 't' })).toThrow(/0\.\.100/);
  });

  it('accepts the boundaries 0 and 100', () => {
    expect(validationResponseCall({ requestHash: REQ_HASH, response: 0, responseURI: 'u', responseHash: RES_HASH, tag: 't' }).args[1]).toBe(0);
    expect(validationResponseCall({ requestHash: REQ_HASH, response: 100, responseURI: 'u', responseHash: RES_HASH, tag: 't' }).args[1]).toBe(100);
  });
});
