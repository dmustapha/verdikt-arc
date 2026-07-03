import { describe, it, expect } from 'vitest';
import { ContractFunctionRevertedError } from 'viem';
import { readValidationStatus, readAgentIdentity, ERC8004_VALIDATION_REGISTRY, type ReadClient } from '../src/erc8004.js';

const revert = (reason: string) => new ContractFunctionRevertedError({ abi: [], functionName: 'x', message: reason } as any);
const fake = (map: Record<string, () => unknown>): ReadClient => ({
  async readContract(args: any) { const fn = map[args.functionName]; if (!fn) throw new Error(`unexpected ${args.functionName}`); return fn(); },
});

describe('sdk readValidationStatus', () => {
  it('maps the tuple to a named struct', async () => {
    const s = await readValidationStatus('0x00' as any, { client: fake({ getValidationStatus: () => ['0xD089Dfc911ea0A5cA7A54ff912ab73B5531D02D7', 7395n, 100, '0x' + 'ee'.repeat(32), 'verdikt:release', 42n] }) });
    expect(s).toMatchObject({ agentId: 7395n, response: 100, tag: 'verdikt:release', lastUpdate: 42n });
  });
  it('null on the "unknown" revert, rethrow on RPC error', async () => {
    expect(await readValidationStatus('0x00' as any, { client: fake({ getValidationStatus: () => { throw revert('unknown'); } }) })).toBeNull();
    await expect(readValidationStatus('0x00' as any, { client: fake({ getValidationStatus: () => { throw new Error('net'); } }) })).rejects.toThrow('net');
  });
  it('exports the canonical validation registry address', () => {
    expect(ERC8004_VALIDATION_REGISTRY).toBe('0x8004Cb1BF31DAf7788923b405b754f57acEB4272');
  });
});

describe('sdk readAgentIdentity', () => {
  it('returns a checksummed owner + card + bound wallet', async () => {
    const id = await readAgentIdentity(7395n, { client: fake({
      ownerOf: () => '0xd089dfc911ea0a5ca7a54ff912ab73b5531d02d7', tokenURI: () => 'data:application/json;base64,abc', getAgentWallet: () => '0xd089dfc911ea0a5ca7a54ff912ab73b5531d02d7',
    }) });
    expect(id!.owner).toBe('0xD089Dfc911ea0A5cA7A54ff912ab73B5531D02D7');
    expect(id!.tokenURI).toContain('data:application/json');
  });
  it('null for a nonexistent agentId', async () => {
    expect(await readAgentIdentity(999n, { client: fake({ ownerOf: () => { throw revert('invalid token'); } }) })).toBeNull();
  });
});
