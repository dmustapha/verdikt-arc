// D1.0 — re-verify the canonical ERC-8004 registries on Base Sepolia BEFORE wiring anything.
// The MASTER-PLAN rule: "re-verify every address + ABI on-chain (getCode) before wiring." An
// unverified address is a wrong-chain / typo landmine, so this is a hard gate, not a formality.
//
// Run: from repo root `set -a; . ./.env; set +a` then `npx tsx worker/src/scripts/verify-erc8004-onchain.ts`
import { createPublicClient, http, getAddress } from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  ERC8004_IDENTITY_REGISTRY,
  ERC8004_REPUTATION_REGISTRY,
  ERC8004_VALIDATION_REGISTRY,
  BASE_SEPOLIA_CHAIN_ID,
} from '../lib/erc8004-constants.js';

const RPC = (process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org').trim();
const ATTESTOR = (process.env.ERC8004_ATTESTOR_ADDRESS ?? process.env.DEMO_PAYER_ADDRESS ?? '').trim();

// Minimal ABIs for the verification reads only.
const VALIDATION_ABI = [
  { type: 'function', name: 'getVersion', stateMutability: 'pure', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'getIdentityRegistry', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
const IDENTITY_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

async function main() {
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

  const netId = await client.getChainId();
  if (netId !== BASE_SEPOLIA_CHAIN_ID) throw new Error(`RPC is chain ${netId}, expected Base Sepolia ${BASE_SEPOLIA_CHAIN_ID}`);
  console.log(`RPC ok — Base Sepolia (${netId}) via ${RPC}`);

  // 1. getCode: all three must be deployed contracts (non-empty bytecode).
  for (const [label, addr] of [
    ['IdentityRegistry', ERC8004_IDENTITY_REGISTRY],
    ['ReputationRegistry', ERC8004_REPUTATION_REGISTRY],
    ['ValidationRegistry', ERC8004_VALIDATION_REGISTRY],
  ] as const) {
    const code = await client.getCode({ address: addr });
    if (!code || code === '0x') throw new Error(`${label} ${addr} has NO bytecode on Base Sepolia`);
    console.log(`  ✓ ${label.padEnd(20)} ${addr}  (${(code.length - 2) / 2} bytes)`);
  }

  // 2. ValidationRegistry interface sanity: version + wired Identity Registry.
  const version = await client.readContract({ address: ERC8004_VALIDATION_REGISTRY, abi: VALIDATION_ABI, functionName: 'getVersion' });
  const wiredIdentity = await client.readContract({ address: ERC8004_VALIDATION_REGISTRY, abi: VALIDATION_ABI, functionName: 'getIdentityRegistry' });
  console.log(`  ValidationRegistry.getVersion() = ${version}`);
  console.log(`  ValidationRegistry.getIdentityRegistry() = ${wiredIdentity}`);
  if (getAddress(wiredIdentity) !== getAddress(ERC8004_IDENTITY_REGISTRY)) {
    throw new Error(`ValidationRegistry points at ${wiredIdentity}, expected canonical Identity ${ERC8004_IDENTITY_REGISTRY}`);
  }
  console.log('  ✓ ValidationRegistry is wired to the canonical Identity Registry');

  // 3. IdentityRegistry interface sanity: ERC-721 name/symbol.
  const name = await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: 'name' });
  const symbol = await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: 'symbol' });
  console.log(`  IdentityRegistry name()/symbol() = ${name} / ${symbol}`);

  // 4. Attestor gas: the EOA that will open requests + post responses needs Base Sepolia ETH.
  if (ATTESTOR) {
    const bal = await client.getBalance({ address: getAddress(ATTESTOR) });
    console.log(`  Attestor ${ATTESTOR} balance = ${bal} wei (${Number(bal) / 1e18} ETH)`);
    if (bal === 0n) console.log('  ⚠ attestor has ZERO Base Sepolia ETH — fund before the live write (D1.7)');
  } else {
    console.log('  ⚠ no ERC8004_ATTESTOR_ADDRESS / DEMO_PAYER_ADDRESS set — cannot check attestor gas');
  }

  console.log('\nD1.0 PASS — canonical ERC-8004 registries verified on Base Sepolia.');
}

main().catch((e) => { console.error('D1.0 FAIL:', e.message); process.exit(1); });
