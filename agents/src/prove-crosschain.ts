import { privateKeyToAccount } from 'viem/accounts';
import {
  Verdikt, CHAINS, relayOutbound,
  type CrossChainConfig, type Acceptance, type Artifact, type ChainKey,
} from '@verdikt/sdk';

// X2 PROOF: the full multi-chain round-trip. Neither agent lives on Arc — Arc is the clearing house.
//   leg 1  buyer BURNS on the SOURCE chain (e.g. Ethereum Sepolia) → Arc hook
//   leg 2  Arc mintAndFund (hook mints + funds the escrow)
//   leg 3  Arc settle() — verdict releases AND burns the payout to the seller's home chain
//   leg 4  destination receiveMessage — seller is paid OUT on THEIR chain (e.g. Base Sepolia)
// Deterministic tool_output schema task so the RELEASE doesn't depend on an LLM.

const ENDPOINT = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const ARC_RPC = process.env.ARC_RPC_URL;
const ARC_TX = 'https://testnet.arcscan.app/tx/';
const AMOUNT = Number(process.env.XCHAIN_AMOUNT_USDC ?? 0.5);

// Corridor (override via env): buyer funds from SOURCE, seller is paid out on DEST.
const SOURCE = (process.env.SOURCE_CHAIN ?? 'ethereumSepolia') as ChainKey;
const DEST = (process.env.DEST_CHAIN ?? 'baseSepolia') as ChainKey;

const PAYER_KEY = (process.env.DEMO_PAYER_KEY ?? '').trim() as `0x${string}`;
const SELLER_KEY = (process.env.WORKER_GATEWAY_KEY ?? '').trim() as `0x${string}`;
const HOOK = (process.env.HOOK_ADDRESS ?? '').trim() as `0x${string}`;
// Whoever relays the outbound mint just needs gas on the DEST chain (permissionless). Default: payer.
const RELAYER_KEY = (process.env.RELAYER_KEY ?? process.env.DEMO_PAYER_KEY ?? '').trim() as `0x${string}`;

const line = (s = '') => console.log(s);

async function main() {
  if (!PAYER_KEY || !SELLER_KEY) throw new Error('DEMO_PAYER_KEY and WORKER_GATEWAY_KEY required');
  if (!HOOK) throw new Error('HOOK_ADDRESS required');

  const payer = new Verdikt({ endpoint: ENDPOINT, rpcUrl: ARC_RPC, signer: { privateKey: PAYER_KEY } });
  const seller = new Verdikt({ endpoint: ENDPOINT, rpcUrl: ARC_RPC, signer: { privateKey: SELLER_KEY } });
  const sellerAddr = (seller as unknown as { _account: { address: `0x${string}` } })._account.address;
  const srcInfo = CHAINS[SOURCE], destInfo = CHAINS[DEST];

  line(`Verdikt X2 full round-trip → ${ENDPOINT}`);
  line(`  buyer funds from:  ${srcInfo.name} (domain ${srcInfo.cctpDomain})${srcInfo.agentNote ? ` — ${srcInfo.agentNote}` : ''}`);
  line(`  seller paid out on: ${destInfo.name} (domain ${destInfo.cctpDomain})${destInfo.agentNote ? ` — ${destInfo.agentNote}` : ''}`);
  line(`  the link: Arc escrow + hook ${HOOK}`);
  line(`  seller (paid on ${destInfo.name} at): ${sellerAddr}`);

  const acceptance: Acceptance = {
    spec: 'Return a price feed JSON with a string symbol and a non-negative number price.',
    schema: { symbol: { type: 'string', required: true }, price: { type: 'number', required: true, min: 0 } },
    minResponseBytes: 10,
  };

  line('\n· seller onboarding onto Circle Gateway (idempotent)…');
  const ob = await seller.seller.ensureOnboarded();
  line(`  available=${ob.availableUsdc} USDC`);

  const crossChain: CrossChainConfig = {
    hook: HOOK, sourceChain: SOURCE,
    sourceRpcUrl: process.env.SOURCE_RPC_URL, arcRpcUrl: ARC_RPC,
  };

  line(`\n· payer commissioning a ${AMOUNT} USDC task funded from ${srcInfo.name}, seller paid on ${destInfo.name}…`);
  const t = await payer.payer.createTaskCrossChain({
    type: 'tool_output', acceptance, amountUsdc: AMOUNT, seller: sellerAddr, crossChain,
    sellerPayout: { domain: destInfo.cctpDomain, recipient: sellerAddr },
    onStep: (s) => line(`    · ${s}`),
  });
  line(`  workId: ${t.workId}`);
  line(`  LEG 1 burn (${srcInfo.name}): ${srcInfo.explorerTx}${t.burnTxHash}`);
  line(`  LEG 2 fund (Arc):            ${ARC_TX}${t.fundTxHash}`);
  line(`  escrow holds (fee-net): ${t.escrowedUsdc} USDC`);

  line('\n· seller accepting + submitting the deliverable…');
  await seller.seller.acceptOffer(t.offer);
  const artifact: Artifact = { type: 'tool_output', payload: JSON.stringify({ symbol: 'ARC-USDC', price: 1.0 }) };
  const seen = new Set<string>();
  const result = await seller.seller.submit({
    offer: t.offer, artifact,
    onStep: (st) => {
      if (st.type === 'verdict' && !seen.has('v')) { seen.add('v'); line(`    ⟶ verdict: ${String(st.data.verdict).toUpperCase()}`); }
      else if (st.type === 'settled' && !seen.has('s')) { seen.add('s'); line(`    ⟶ settled: ${st.data.outcome}`); }
    },
  });
  if (result.status !== 'released') throw new Error(`expected release, got ${result.status}`);
  if (!result.settlementTx) throw new Error('no settlement tx');
  line(`  → ${result.verdict.toUpperCase()} / ${result.status.toUpperCase()}`);
  line(`  LEG 3 settle+burn (Arc): ${ARC_TX}${result.settlementTx}`);

  line(`\n· relaying the outbound payout to ${destInfo.name} (seller gets paid on their chain)…`);
  const relayer = privateKeyToAccount(RELAYER_KEY);
  const out = await relayOutbound({
    account: relayer, settleTxHash: result.settlementTx as `0x${string}`, destChain: DEST,
    destRpcUrl: process.env.DEST_RPC_URL, onPoll: (s) => line(`    · iris(arc): ${s}`),
  });
  line(`  LEG 4 mint (${destInfo.name}): ${destInfo.explorerTx}${out.mintTxHash}`);

  line('\n━━━ X2 FULL ROUND-TRIP — four legs ━━━');
  line(`  1. burn   (${srcInfo.name}): ${srcInfo.explorerTx}${t.burnTxHash}`);
  line(`  2. fund   (Arc):            ${ARC_TX}${t.fundTxHash}`);
  line(`  3. settle (Arc, burns out): ${ARC_TX}${result.settlementTx}`);
  line(`  4. paid   (${destInfo.name}): ${destInfo.explorerTx}${out.mintTxHash}`);
  line(`\n  ${srcInfo.name} buyer → Arc clearing house → ${destInfo.name} seller. Neither lives on Arc.`);
  line('\n[X2 full round-trip proof PASS]');
}

main().catch((e) => { console.error('\n[X2 proof FATAL]', e); process.exit(1); });
