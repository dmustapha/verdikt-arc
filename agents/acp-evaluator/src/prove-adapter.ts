// WS12 — de-risk Option 2 BEFORE funding anything. Proves the raw-EOA adapter works end-to-end short of
// spending: read path (USDC decimals), sign path (the ACP AgentAuth EIP-712 payload), and — the real
// make-or-break — whether an UNREGISTERED raw EOA can authenticate to the Virtuals ACP server and connect
// to its event stream. If start() resolves, auth does not require a registered Privy agent and the full
// live job (buyer+seller as raw EOAs) is viable. If it 401s, fall back to Option 1.
//
// Run:  set -a; . agents/acp-evaluator/.env; set +a; npx tsx agents/acp-evaluator/src/prove-adapter.ts
import { AcpAgent } from '@virtuals-protocol/acp-node-v2';
import { erc20Abi, type Hex, type TypedDataDefinition } from 'viem';
import { base } from 'viem/chains';
import { ViemEoaProviderAdapter } from './viem-adapter.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// The exact EIP-712 payload the ACP server verifies at POST /auth/agent (mirrors the SDK's internal
// buildAgentAuthTypedData, which isn't re-exported from the package root).
function agentAuthTypedData(wallet: string, chainId: number, issuedAt: number): TypedDataDefinition {
  return {
    domain: { name: 'ACP', version: '1', chainId },
    types: { AgentAuth: [
      { name: 'wallet', type: 'address' },
      { name: 'chainId', type: 'uint256' },
      { name: 'issuedAt', type: 'uint256' },
    ] },
    primaryType: 'AgentAuth',
    message: { wallet, chainId: BigInt(chainId), issuedAt: BigInt(issuedAt) },
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const adapter = new ViemEoaProviderAdapter(requireEnv('LIVE_BUYER_KEY') as Hex);

  // 1. identity
  const addr = await adapter.getAddress();
  const chains = await adapter.getSupportedChainIds();
  console.log(`1. getAddress            = ${addr}`);
  console.log(`   getSupportedChainIds  = [${chains.join(', ')}]`);

  // 2. read path — USDC decimals off Base
  const decimals = await adapter.readContract(base.id, {
    address: USDC, abi: erc20Abi, functionName: 'decimals',
  });
  console.log(`2. readContract USDC.decimals = ${decimals} (expect 6)`);

  // 3. sign path — the exact EIP-712 payload the ACP server verifies for auth
  const typedData = agentAuthTypedData(addr, base.id, Math.floor(Date.now() / 1000));
  const sig = await adapter.signTypedData(base.id, typedData);
  console.log(`3. signTypedData(AgentAuth) = ${sig.slice(0, 22)}… (len ${sig.length})`);

  // 4. THE make-or-break: authenticate + connect to Virtuals ACP as an unregistered raw EOA
  console.log('4. connecting to Virtuals ACP as an unregistered raw EOA…');
  const agent = await AcpAgent.create({ provider: adapter });
  let connected = false;
  await Promise.race([
    agent.start(() => { connected = true; }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout (20s)')), 20_000)),
  ]);
  console.log(`   ✅ AUTH OK — raw EOA connected to ACP (onConnected fired: ${connected}). Option 2 is viable.`);
  await agent.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ adapter proof failed:', e instanceof Error ? e.message : e);
  console.error('   If this is an auth/401 error, the ACP server requires a registered agent → use Option 1.');
  process.exit(1);
});
