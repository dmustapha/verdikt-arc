# Verdikt — Scope

## What Verdikt is
**Non-custodial infrastructure: a verification + escrow rail between two independent agents.** A buyer agent escrows USDC against a task it defines; a seller agent delivers a work artifact; an evidence-based verdict engine releases the escrow to the seller, refunds the buyer, or abstains. Verdikt never holds the money and never does the work.

It is **not** a marketplace (it does not match or discover agents), **not** the worker (it does not produce deliverables), and **not** a custodian (funds live in a contract, not a Verdikt account).

## The three actors
- **Buyer / payer agent** — defines acceptance criteria up front, escrows USDC.
- **Seller / provider agent** — delivers the artifact, gets paid on a verified release.
- **Verdikt (the arbiter)** — escrow contract on Arc + off-chain verdict engine + Circle DCW settlement signer.

> Naming: reserve "worker" for the `verdikt-worker` backend service. The party is the **seller**.

## What it verifies (the honest boundary)
Verdikt verifies **only what is checkable against payer-supplied ground truth**:

| Artifact | The exact question answered | How |
|---|---|---|
| `code` | Does it pass the payer's tests with no flagged security vuln? | payer's pytest + Semgrep + Bandit in a network-isolated sandbox |
| `tool_output` (JSON) | Does it conform to the payer's JSON contract? | structural + format + bounds validation |
| `answer` (text) | Is the key claim supported by a verbatim span in the payer's sources? | LLM-proposed claim + deterministic entailment gate |

It does **not** verify, and explicitly **abstains** on: subjective quality ("is this code well-architected / is this essay good"), open-world truth without supplied sources, authorization/business-logic correctness, anything needing taste or intent-fit.

## What governs verification quality
1. **The payer's criteria — the dominant factor.** The verdict is only as strong as the tests/schema/sources supplied. Verdikt verifies against the payer's definition of good; it does not invent one.
2. **Route reliability:** schema (highest, deterministic) > code-with-execution (high, conditional on real tests) > grounding (~75-85%, abstain-heavy).
3. **The deterministic floor:** no false-certify on any failing evidence, independent of the model.
4. **Abstain-on-uncertainty:** refunds rather than guesses. A verifier that false-certifies is worse than none.

## Transaction topology (non-custodial)
The buyer's USDC enters the `VerdiktEscrow` contract and is released **by contract code** to the seller (release) or buyer (refund/abstain). The Circle DCW signs `settle()` but the outcome is **derived on-chain from the verdict code**, so even our signer cannot pay an outcome that contradicts the verdict. The only money Verdikt earns is the per-verdict fee (see `FEE-MODEL.md`). The buyer and seller are independent and meet *through* the rail.

## Worker independence
Architecturally the seller is independent: `/api/verdict` accepts any seller's signed artifact against a funded escrow and settles to that seller's address. In the current demo, both parties are self-generated with real on-chain settlements; v1 makes independent sellers first-class (signed Task Offers).
