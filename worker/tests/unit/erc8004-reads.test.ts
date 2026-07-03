import { describe, it, expect } from 'vitest';
import { ContractFunctionRevertedError } from 'viem';
import { readValidationStatus, readAgentIdentity, type ReadClient } from '../../src/lib/erc8004.js';

// A revert the helper must treat as an honest "absent" → null (never confuse with an RPC failure).
const revert = (reason: string) =>
  new ContractFunctionRevertedError({ abi: [], functionName: 'x', message: reason } as any);

// A fake read client whose behavior is keyed by functionName, so one mock serves multi-read helpers.
function fakeClient(map: Record<string, () => unknown>): ReadClient {
  return {
    async readContract(args: any) {
      const fn = map[args.functionName];
      if (!fn) throw new Error(`unexpected readContract ${args.functionName}`);
      return fn();
    },
  };
}

describe('readValidationStatus', () => {
  it('maps the 6-field tuple to a named struct', async () => {
    const client = fakeClient({
      getValidationStatus: () => [
        '0x927c1D756d12879aEBeA0772f3EE220f21f4841A', 42n, 88,
        '0xabc0000000000000000000000000000000000000000000000000000000000abc',
        'verdikt:release', 1720000000n,
      ],
    });
    const s = await readValidationStatus('0xdead' as any, client);
    expect(s).not.toBeNull();
    expect(s!.validatorAddress).toBe('0x927c1D756d12879aEBeA0772f3EE220f21f4841A');
    expect(s!.agentId).toBe(42n);
    expect(s!.response).toBe(88);
    expect(s!.tag).toBe('verdikt:release');
    expect(s!.lastUpdate).toBe(1720000000n);
  });

  it('returns null when the requestHash was never requested (contract reverts "unknown")', async () => {
    const client = fakeClient({ getValidationStatus: () => { throw revert('unknown'); } });
    expect(await readValidationStatus('0xdead' as any, client)).toBeNull();
  });

  it('rethrows a transport/RPC error (must not be swallowed as "absent")', async () => {
    const client = fakeClient({ getValidationStatus: () => { throw new Error('fetch failed'); } });
    await expect(readValidationStatus('0xdead' as any, client)).rejects.toThrow('fetch failed');
  });
});

describe('readAgentIdentity', () => {
  it('returns owner + tokenURI + bound wallet for a real agent', async () => {
    const client = fakeClient({
      ownerOf: () => '0xd089dfc911ea0a5ca7a54ff912ab73b5531d02d7',
      tokenURI: () => 'https://verdikt-worker.fly.dev/agents/1.json',
      getAgentWallet: () => '0x927c1d756d12879aebea0772f3ee220f21f4841a',
    });
    const id = await readAgentIdentity(1n, client);
    expect(id).not.toBeNull();
    expect(id!.owner).toBe('0xD089Dfc911ea0A5cA7A54ff912ab73B5531D02D7'); // checksummed
    expect(id!.tokenURI).toBe('https://verdikt-worker.fly.dev/agents/1.json');
    expect(id!.agentWallet).toBe('0x927c1D756d12879aEBeA0772f3EE220f21f4841A');
  });

  it('returns null for a nonexistent agentId (ownerOf reverts)', async () => {
    const client = fakeClient({ ownerOf: () => { throw revert('ERC721: invalid token ID'); } });
    expect(await readAgentIdentity(999n, client)).toBeNull();
  });

  it('degrades getAgentWallet revert to the zero address (agent never bound a wallet)', async () => {
    const client = fakeClient({
      ownerOf: () => '0xd089dfc911ea0a5ca7a54ff912ab73b5531d02d7',
      tokenURI: () => 'ipfs://card',
      getAgentWallet: () => { throw revert('no wallet'); },
    });
    const id = await readAgentIdentity(2n, client);
    expect(id!.agentWallet).toBe('0x0000000000000000000000000000000000000000');
  });
});
