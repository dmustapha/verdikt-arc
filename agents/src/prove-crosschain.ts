import { Verdikt, type CrossChainConfig, type Acceptance, type Artifact } from '@verdikt/sdk';

// X1 PROOF: one clean Base Sepolia → Arc fund-to-settle over Circle CCTP V2.
//   leg 1  burn on Base Sepolia (depositForBurnWithHook → Arc hook)
//   leg 2  mintAndFund on Arc (hook mints the USDC to itself + funds the escrow)
//   leg 3  settle on Arc (verdict engine releases to the seller)
// The task is a deterministic tool_output schema check so the RELEASE doesn't depend on an LLM.

const ENDPOINT = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const ARC_RPC = process.env.ARC_RPC_URL;
const ARC_EXPLORER = 'https://testnet.arcscan.app/tx/';
const BASE_EXPLORER = 'https://sepolia.basescan.org/tx/';
const AMOUNT = Number(process.env.XCHAIN_AMOUNT_USDC ?? 0.5);

const PAYER_KEY = (process.env.DEMO_PAYER_KEY ?? '').trim() as `0x${string}`;
const SELLER_KEY = (process.env.WORKER_GATEWAY_KEY ?? '').trim() as `0x${string}`;
const HOOK = (process.env.HOOK_ADDRESS ?? '').trim() as `0x${string}`;

const line = (s = '') => console.log(s);

async function main() {
  if (!PAYER_KEY || !SELLER_KEY) throw new Error('DEMO_PAYER_KEY and WORKER_GATEWAY_KEY required');
  if (!HOOK) throw new Error('HOOK_ADDRESS required');

  const payer = new Verdikt({ endpoint: ENDPOINT, rpcUrl: ARC_RPC, signer: { privateKey: PAYER_KEY } });
  const seller = new Verdikt({ endpoint: ENDPOINT, rpcUrl: ARC_RPC, signer: { privateKey: SELLER_KEY } });

  const sellerAddr = (seller as unknown as { _account: { address: `0x${string}` } })._account.address;
  line(`Verdikt X1 cross-chain proof → ${ENDPOINT}`);
  line(`  payer  (Base Sepolia funder + Arc relayer): ${(payer as unknown as { _account: { address: string } })._account.address}`);
  line(`  seller (Arc):                               ${sellerAddr}`);
  line(`  hook   (Arc EscrowFundingHook):             ${HOOK}`);

  // A deterministic tool_output schema task: a price-feed JSON the seller returns verbatim.
  const acceptance: Acceptance = {
    spec: 'Return a price feed JSON with a string symbol and a non-negative number price.',
    schema: {
      symbol: { type: 'string', required: true },
      price: { type: 'number', required: true, min: 0 },
    },
    minResponseBytes: 10,
  };

  line('\n· seller onboarding onto Circle Gateway (idempotent)…');
  const ob = await seller.seller.ensureOnboarded();
  line(`  onboarded=${ob.onboarded} deposited=${ob.deposited} available=${ob.availableUsdc} USDC`);

  const crossChain: CrossChainConfig = {
    hook: HOOK,
    sourceRpcUrl: process.env.BASE_SEPOLIA_RPC_URL,
    arcRpcUrl: ARC_RPC,
  };

  line(`\n· payer commissioning a ${AMOUNT} USDC task funded from Base Sepolia over CCTP…`);
  const t = await payer.payer.createTaskCrossChain({
    type: 'tool_output', acceptance, amountUsdc: AMOUNT, seller: sellerAddr, crossChain,
    onStep: (s) => line(`    · ${s}`),
  });
  line(`  workId:        ${t.workId}`);
  line(`  LEG 1 burn   (Base Sepolia): ${BASE_EXPLORER}${t.burnTxHash}`);
  line(`  LEG 2 fund   (Arc mintAndFund): ${ARC_EXPLORER}${t.fundTxHash}`);
  line(`  escrow now holds (fee-net):  ${t.escrowedUsdc} USDC`);

  line('\n· seller accepting the offer (escrow verified funded on Arc)…');
  await seller.seller.acceptOffer(t.offer);

  const artifact: Artifact = {
    type: 'tool_output',
    payload: JSON.stringify({ symbol: 'ARC-USDC', price: 1.0 }),
  };
  line('· seller submitting the deliverable + paying the x402 fee…');
  const seen = new Set<string>();
  const result = await seller.seller.submit({
    offer: t.offer, artifact,
    onStep: (st) => {
      if (st.type === 'route_selected') line(`    ⟶ route: ${st.data.route}`);
      else if (st.type === 'verdict' && !seen.has('v')) { seen.add('v'); line(`    ⟶ verdict: ${String(st.data.verdict).toUpperCase()}`); }
      else if (st.type === 'settled' && !seen.has('s')) { seen.add('s'); line(`    ⟶ settled: ${st.data.outcome}`); }
    },
  });

  line(`\n  → VERDICT: ${result.verdict.toUpperCase()}  OUTCOME: ${result.status.toUpperCase()}  fee: ${result.feeUsdc} USDC`);
  line(`  LEG 3 settle (Arc): ${ARC_EXPLORER}${result.settlementTx}`);

  line('\n━━━ X1 PROOF — three legs ━━━');
  line(`  1. burn   (Base Sepolia): ${BASE_EXPLORER}${t.burnTxHash}`);
  line(`  2. fund   (Arc):          ${ARC_EXPLORER}${t.fundTxHash}`);
  line(`  3. settle (Arc):          ${ARC_EXPLORER}${result.settlementTx}`);
  if (result.status !== 'released') throw new Error(`expected release, got ${result.status}`);
  line('\n[X1 cross-chain proof PASS]');
}

main().catch((e) => { console.error('\n[X1 proof FATAL]', e); process.exit(1); });
