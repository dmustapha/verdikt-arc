# Verdikt — Fee Model

## Principle
**If we can't verify, we don't take their money.** Verdikt monetizes *rendered verdicts*, not attempts.

## Auth-and-capture (Stripe-style)
The verdict fee (sub-cent USDC, default `$0.001`) is settled through Circle Gateway (x402) in two phases:

1. **Authorize** (up front): on `POST /api/verdict`, the fee authorization is *verified* via the facilitator's `/verify`. This proves the caller can pay, so we never run an expensive verdict for a non-payer. **No funds move yet.**
2. **Capture** (after the verdict): the fee is *settled* via `/settle` **only when a verdict is rendered** — `release` or `refund` — and the escrow settled on-chain.
3. **Void**: on `abstain` (we could not verify) or a failed settlement, the authorization is dropped. **The seller pays nothing.**

Proven live (2026-06-28): release → `feeUsdc 0.001` captured; abstain → `feeUsdc 0`, escrow refunded to the buyer.

## Who pays, and for what
**The seller agent pays the verdict fee** (the party calling `/api/verdict` to get its work judged). It pays for **the verification service** — the sandbox run, scanners, reasoner, and on-chain settlement orchestration — *not* the job payment. The job payment is the buyer's escrowed USDC, which the seller *receives* on release.

### Why the seller, not the buyer
| Outcome | Seller fee | Seller gets | Effect |
|---|---|---|---|
| good → release | pays `$0.001` | the escrow (job payment) | tiny cost to unlock payment |
| bad → refund | pays `$0.001` | nothing | junk penalty — deters bad submissions |
| can't verify → abstain | **free** | nothing (buyer refunded) | our limitation, not their fault |

Buyer-pays was rejected: it would let a malicious seller grief the buyer's wallet by spamming submissions that burn the buyer's fees. Seller-pays + abstain-free removes that vector and aligns incentives.

## Business model
Per-rendered-verdict fee. Abstains and failures-to-verify are free. The escrow principal is never a revenue source — it is non-custodial and only ever moves to the seller (release) or back to the buyer (refund/abstain).

## Implementation
`worker/src/lib/x402-meter.ts` (`verifyViaGateway` authorize, `captureViaGateway` + `captureVerdictFee` capture) and `worker/src/routes/verdict.ts` (captures only when `txHash` present and `outcome ∈ {release, refund}`). The demo path (`/api/demo`) is intentionally unmetered so the on-camera hero never hits a 402.
