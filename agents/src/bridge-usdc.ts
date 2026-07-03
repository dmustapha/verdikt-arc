// WS9.1 — USDC provisioning via a plain CCTP V2 bridge (no hook, EOA→EOA).
//
// The corridor matrix needs the payer to hold principal on EVERY source chain. Ethereum + Base
// Sepolia are already funded; Arbitrum / OP / Polygon are empty. This seeds them by bridging USDC
// from a funded chain to the payer's own address on each target, using the SAME CCTP V2 primitives
// the product uses (TokenMessengerV2.depositForBurn → Iris attestation → MessageTransmitterV2
// .receiveMessage). Domains are read from the SDK CHAINS registry — nothing hardcoded.
//
// Idempotent: skips a target already holding >= the requested amount. Requires native gas on the
// source (to burn) and on each dest (to receiveMessage) — the payer holds gas on all of them.
//
// Run:  set -a; . ./.env; set +a;  npx tsx agents/src/bridge-usdc.ts
import { privateKeyToAccount } from 'viem/accounts';
import {
  createWalletClient, createPublicClient, http, parseUnits, formatUnits,
  encodeFunctionData, defineChain, pad,
} from 'viem';
import type { Account, Chain } from 'viem';
import {
  chainInfo, addressToBytes32, pollAttestation,
  TOKEN_MESSENGER_V2, MESSAGE_TRANSMITTER_V2, type ChainKey, type ChainInfo,
} from '@verdikt/sdk';

const PAYER_KEY = (process.env.DEMO_PAYER_KEY ?? '').trim() as `0x${string}`;
const SOURCE = (process.env.BRIDGE_SOURCE ?? 'baseSepolia') as ChainKey;

// Provisioning targets (amounts, not domains — domains come from CHAINS[dest].cctpDomain).
const TARGETS: Array<{ dest: ChainKey; amountUsdc: number }> = [
  { dest: 'arbitrumSepolia', amountUsdc: 0.7 },
  { dest: 'opSepolia', amountUsdc: 0.7 },
  { dest: 'polygonAmoy', amountUsdc: 0.7 },
];

const ZERO32 = pad('0x', { size: 32 });
const line = (s = '') => console.log(s);

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

// CCTP V2 plain depositForBurn (the hook variant adds a trailing bytes hookData; this omits it).
const DEPOSIT_FOR_BURN_ABI = [{
  type: 'function', name: 'depositForBurn', stateMutability: 'nonpayable',
  inputs: [
    { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' },
    { name: 'mintRecipient', type: 'bytes32' }, { name: 'burnToken', type: 'address' },
    { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' },
    { name: 'minFinalityThreshold', type: 'uint32' },
  ],
  outputs: [],
}] as const;

const RECEIVE_MESSAGE_ABI = [{
  type: 'function', name: 'receiveMessage', stateMutability: 'nonpayable',
  inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }],
  outputs: [{ type: 'bool' }],
}] as const;

function viemChain(c: ChainInfo): Chain {
  return defineChain({
    id: c.chainId, name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [c.rpcUrl] } }, testnet: true,
  });
}

async function usdcBalance(c: ChainInfo, addr: `0x${string}`): Promise<bigint> {
  const pub = createPublicClient({ chain: viemChain(c), transport: http(c.rpcUrl) });
  return (await pub.readContract({ address: c.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] })) as bigint;
}

// Bridge `amountUsdc` from SOURCE to the payer's own address on `dest`. Fast Transfer where the
// source supports it (small maxFee), else standard (fee-free, slower finality).
async function bridgeOne(account: Account, src: ChainInfo, dest: ChainInfo, amountUsdc: number): Promise<void> {
  const amount = parseUnits(amountUsdc.toFixed(6), 6);
  const maxFee = src.fastSource ? parseUnits('0.01', 6) : 0n;
  const finality = src.fastSource ? 1000 : 2000;

  const srcChain = viemChain(src);
  const wallet = createWalletClient({ account, chain: srcChain, transport: http(src.rpcUrl) });
  const pub = createPublicClient({ chain: srcChain, transport: http(src.rpcUrl) });

  line(`  approve ${amountUsdc} USDC → TokenMessenger on ${src.name}…`);
  const approveTx = await wallet.sendTransaction({
    to: src.usdc,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [TOKEN_MESSENGER_V2, amount] }),
  });
  await pub.waitForTransactionReceipt({ hash: approveTx, timeout: 120_000 });

  // Confirm the fresh allowance is visible before burning. Public testnet RPCs are load-balanced;
  // the burn's gas estimate can race a lagging node that still reads allowance 0 → the depositForBurn
  // transferFrom reverts with "ERC20: transfer amount exceeds allowance". Poll until the node agrees.
  for (let i = 0; ; i++) {
    const seen = (await pub.readContract({
      address: src.usdc, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, TOKEN_MESSENGER_V2],
    })) as bigint;
    if (seen >= amount) break;
    if (i >= 30) throw new Error(`allowance not visible on ${src.name} after approve (saw ${seen})`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  line(`  burn on ${src.name} (domain ${src.cctpDomain}) → mint to payer on ${dest.name} (domain ${dest.cctpDomain})…`);
  const burnTx = await wallet.sendTransaction({
    to: TOKEN_MESSENGER_V2,
    data: encodeFunctionData({
      abi: DEPOSIT_FOR_BURN_ABI, functionName: 'depositForBurn',
      args: [amount, dest.cctpDomain, addressToBytes32(account.address), src.usdc, ZERO32, maxFee, finality],
    }),
  });
  const burnReceipt = await pub.waitForTransactionReceipt({ hash: burnTx, timeout: 120_000 });
  if (burnReceipt.status !== 'success') throw new Error(`depositForBurn reverted on ${src.name}`);
  line(`    burn: ${src.explorerTx}${burnTx}`);

  line(`  polling Iris for attestation…`);
  const { message, attestation } = await pollAttestation({
    burnTxHash: burnTx, sourceDomain: src.cctpDomain,
    timeoutMs: 1_200_000, // standard finality on testnet can take 10–20 min
    onPoll: (s) => line(`    · iris(${src.name}): ${s}`),
  });

  line(`  receiveMessage on ${dest.name}…`);
  const destChain = viemChain(dest);
  const dwallet = createWalletClient({ account, chain: destChain, transport: http(dest.rpcUrl) });
  const dpub = createPublicClient({ chain: destChain, transport: http(dest.rpcUrl) });
  const mintTx = await dwallet.sendTransaction({
    to: MESSAGE_TRANSMITTER_V2,
    data: encodeFunctionData({ abi: RECEIVE_MESSAGE_ABI, functionName: 'receiveMessage', args: [message, attestation] }),
  });
  const mintReceipt = await dpub.waitForTransactionReceipt({ hash: mintTx, timeout: 120_000 });
  if (mintReceipt.status !== 'success') throw new Error(`receiveMessage reverted on ${dest.name}`);
  line(`    mint: ${dest.explorerTx}${mintTx}`);
}

async function main() {
  if (!PAYER_KEY) throw new Error('DEMO_PAYER_KEY required');
  const account = privateKeyToAccount(PAYER_KEY);
  const src = chainInfo(SOURCE);
  line(`\nWS9.1 USDC provisioning — bridging from ${src.name} to payer ${account.address}`);

  const srcBal = await usdcBalance(src, account.address);
  const needed = TARGETS.reduce((s, t) => s + t.amountUsdc, 0);
  line(`  source ${src.name} USDC balance: ${formatUnits(srcBal, 6)} (need ~${needed} + fees)\n`);

  for (const t of TARGETS) {
    const dest = chainInfo(t.dest);
    const have = await usdcBalance(dest, account.address);
    const target = parseUnits(t.amountUsdc.toFixed(6), 6);
    if (have >= target) {
      line(`· ${dest.name}: already funded (${formatUnits(have, 6)} USDC ≥ ${t.amountUsdc}) — skip`);
      continue;
    }
    line(`· ${dest.name}: has ${formatUnits(have, 6)} USDC, bridging ${t.amountUsdc}…`);
    await bridgeOne(account, src, dest, t.amountUsdc);
    const after = await usdcBalance(dest, account.address);
    line(`  ✓ ${dest.name} now holds ${formatUnits(after, 6)} USDC\n`);
  }
  line('[WS9.1 USDC provisioning complete]');
}

main().catch((e) => { console.error('\n[bridge-usdc FATAL]', e); process.exit(1); });
