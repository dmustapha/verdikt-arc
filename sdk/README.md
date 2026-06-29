# @verdikt/sdk

One call per role to use the Verdikt verification + escrow rail between two independent agents on Arc.

A **buyer/payer agent** escrows USDC against acceptance criteria; a **seller/provider agent** delivers an artifact, pays a sub-cent verdict fee, and is paid only if the work is verified. The fee is captured only on a rendered verdict — **abstain is free**.

## Install
```bash
npm install @verdikt/sdk
```

## Payer (buyer) — open a verified-payment job
```ts
import { Verdikt } from '@verdikt/sdk';

const vk = new Verdikt({
  endpoint: 'https://verdikt-worker.fly.dev',
  rpcUrl: 'https://rpc.testnet.arc.network',
  signer: { privateKey: PAYER_KEY },        // key | (CDP / Circle DCW in v2)
});

// Registers criteria, funds the escrow on-chain (EIP-3009), returns a signed Task Offer.
const { workId, offer } = await vk.payer.createTask({
  type: 'code',                              // 'code' | 'tool_output' | 'answer'
  acceptance: { spec: 'parameterized query', tests: pytestFile },
  amountUsdc: 1,
  seller: SELLER_ADDRESS,
});
// hand `offer` (a SignedTaskOffer) to the seller, off-band or via your own channel
```

## Seller (provider) — verify, deliver, get judged
```ts
const vk = new Verdikt({ endpoint, rpcUrl, signer: { privateKey: SELLER_KEY } });

// Verifies the payer signature AND that the escrow is really funded on-chain BEFORE doing work.
await vk.seller.acceptOffer(offer, { expectedAcceptance });

// Signs the artifact, pays the x402 fee via Circle Gateway, awaits the verdict — one call.
const result = await vk.seller.submit({ offer, artifact: { type: 'code', payload: code } });

switch (result.status) {
  case 'released':  /* you were paid the escrow; result.feeUsdc charged */ break;
  case 'refunded':  /* work failed verification; buyer refunded */ break;
  case 'abstained': /* unverifiable — buyer refunded, you paid nothing */ break;
}
```

## Errors (typed)
`EscrowNotFundedError` (offer not backed on-chain) · `InvalidOfferError` (bad signature / expired / criteria mismatch) · `ArtifactSignatureError` (403) · `AlreadyJudgedError` (409 replay) · `PaymentError` (fee not authorized).

## Notes
- Arc testnet (chainId 5042002) only, today. The fee is captured only on `release`/`refund`; `abstain` is free.
- The verdict POST returns the result synchronously (~20s); no polling needed.
- Proven end-to-end against the live worker (`createTask → acceptOffer → submit`, release and abstain).
