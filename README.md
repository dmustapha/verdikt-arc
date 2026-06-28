# Verdikt: escrow that pays a stranger agent only when the work is verified

Verdikt is settlement infrastructure that sits between two agents that have never met. A payer agent escrows USDC on Arc, a worker agent delivers code or data, and an evidence-anchored verdict engine releases, refunds, or abstains. It runs the work, it does not ask an opinion: tests, a static security scan, and schema checks become the evidence, and a hard deterministic floor blocks any release over a security finding even if the language model is wrong.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-black)](https://nextjs.org/)
[![Foundry](https://img.shields.io/badge/Foundry-Solidity-orange)](https://book.getfoundry.sh/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-121_passing-brightgreen)]()

**Live:** [verdikt-arc.vercel.app](https://verdikt-arc-damilolas-projects-fafdf859.vercel.app)

---

![Courtroom](docs/images/courtroom.png)

## Live Demo
**[verdikt-arc-damilolas-projects-fafdf859.vercel.app](https://verdikt-arc-damilolas-projects-fafdf859.vercel.app)**

Open the Courtroom and run any of the five cases. Each click funds a fresh escrow on Arc, the arbiter gathers evidence with no human in the loop, and the verdict settles on-chain in about 20 seconds. The bad-code case is caught by a static security scan and the deterministic floor and is refunded; clean work is released. Every settlement is a real Arc transaction, linked on the Proof and Ledger pages.

## What Is Verdikt?

In the agent economy, agents pay other agents for work, but payment is fire and forget: you pay, then you hope. A stranger agent that delivers garbage has already been paid. The obvious fix is to ask a language model "is this good?", but a model grader is an opinion, not a measurement. It agrees with human judgment only moderately, it can be steered by how a task is framed, and it can be tricked into a confident "pass" by superficial tokens that carry no real reasoning (see the citations in `DEEP-RESEARCH.md`). An opinion that can be gamed cannot be trusted to move money. Circle's own `arc-escrow` sample does exactly this with a single vision-model opinion.

Verdikt replaces the opinion with evidence. The payer defines acceptance criteria, escrows USDC on Arc, and the arbiter routes the job to the right evaluator: code runs in a sandboxed container against the payer's tests with a static security scan, structured output validates against a JSON schema contract, and free-form answers are checked against cited sources. The evidence is hashed and anchored on-chain with the settlement, so any verdict can be replayed and audited. When the evidence cannot certify the work, the arbiter abstains and refunds the payer rather than guessing.

---

## Screenshots
| The courtroom | On-chain proof |
|------|------|
| ![Courtroom](docs/images/courtroom.png) | ![Proof](docs/images/proof.png) |
| **Landing** | **Ledger** |
| ![Landing](docs/images/landing.png) | ![Ledger](docs/images/ledger.png) |

---

## How It Works

```
   PAYER AGENT                  VERDIKT ESCROW (Arbiter)                WORKER AGENT
   (Buyer)                      0x8140...1Ae5 on Arc                    (Seller)
      |                                  |                                  |
      |  1. escrow USDC (EIP-3009)       |                                  |
      |--------------------------------->|                                  |
      |                                  |   2. deliver work + evidence     |
      |                                  |<---------------------------------|
      |                          3. ROUTE the job
      |                       code | schema | grounding
      |                                  |
      |                          4. GATHER evidence (no human)
      |                       sandbox tests + Semgrep/Bandit + schema checks
      |                                  |
      |                          5. DETERMINISTIC FLOOR
      |                 any failing evidence (test, static finding, schema check,
      |                 unsupported claim) => cannot release, computed before the LLM
      |                                  |
      |                          6. REASON over evidence (LLM, cites items)
      |                       pass -> release | fail -> refund | unsure -> abstain
      |                                  |
      |             7. SETTLE on Arc + anchor keccak256(evidence) on-chain
      |<---------- refund ---------------|------------ release ------------>|
```

### The three outcomes
| Outcome | When | Money |
|---------|------|-------|
| **Release** | Tests pass, scan clean, schema valid, reasoner certifies | USDC to the worker |
| **Refund** | A test fails, a static finding lands, or the schema breaks | USDC back to the payer |
| **Abstain** | No evaluator can judge the task, or evidence is insufficient | USDC back to the payer (never a false certification) |

### The deterministic floor
The reasoner is a language model, so it can be wrong. The floor is not. Any failing piece of evidence on any route (a failed payer test, a static security finding like a SQL injection flagged by Bandit `B608`, a failed schema check, or an answer span not supported by the cited sources) forces a non-pass before the model is even consulted. The model is consulted only to certify a clean bundle on the release side; it can never overturn a deterministic fail. A release over a real failure is structurally impossible, not a matter of prompt quality, and it does not depend on the model API being reachable.

### Why this needs a chain, not just a model
A model can give you an opinion. It cannot give you an opinion that nobody, including the model's operator, can quietly change after the fact. Verdikt anchors `keccak256(evidence)` in the on-chain `Settled` event, so anyone can later recompute the evidence hash from the bundle and prove the verdict was not altered after settlement. The `/proof` page does this live: the on-chain anchor, the database mirror, and a hash recomputed in the browser from the stored bundle are shown side by side and are identical. Escrow that refunds on failure and a tamper-evident, independently recomputable verdict record are things an LLM fundamentally cannot offer.

### What you trust, and what you don't
Verdikt is escrowed, evidence-anchored, and settled with no human in the loop. It is not "trustless AI verification," and we do not claim that. What the chain guarantees: non-custodial escrow, single-shot settlement, an outcome derived on-chain from the verdict code, and an immutable evidence anchor. What you still trust: the Circle settlement wallet to submit the verdict it computed, and the worker to submit the artifact it actually produced (bound by a worker signature on the public API). The deterministic floor removes trust in the model on the block side; the chain removes trust in the operator on the record side.

---

## Circle and Arc integration

**Escrow funding (EIP-3009 on Arc).** Each job funds a fresh escrow with a gasless `receiveWithAuthorization` pull, bound to a task-derived nonce `keccak256(workId, worker, amount, payer)`. Because `receiveWithAuthorization` requires the token caller to be the payee, the escrow is the only account that can redeem the payer's signed authorization, so a mempool front-runner cannot push the transfer outside the escrow and strand the funds.

**Settlement (Circle Developer-Controlled Wallets).** The verdict wallet signs the on-chain `settle()` through Circle DCW. No human is on the money path: the arbiter decides and Circle executes. The on-chain outcome is derived from the verdict code inside the contract, so the settlement wallet cannot pay out an outcome that contradicts the recorded verdict.

**Metering (x402 + Gateway).** The public verdict API is genuinely metered: a call without a valid `Payment-Signature` returns HTTP 402, and a sub-cent USDC fee (`$0.001`) is settled through Circle Gateway before a verdict is rendered. The `/proof` page surfaces the live counter as the summed total of real settled fees (not a count multiplied by an assumed price); self-serve demo runs are unmetered and excluded, so every fee shown is a genuine third-party paid call.

```ts
// worker/src/routes/verdict.ts: 402 unless the Gateway fee is paid, then bind + lock
verdictRouter.post('/api/verdict', requireVerdictFee, async (req, res) => {
  const task = await getTask(workId);
  // H-2: the artifact must be signed by the task's worker, and a funded escrow can be
  // judged exactly once (single-shot claim); a paid call cannot flip someone else's job.
  if (recover(artifact.sig) !== task.worker) return res.status(403)...;
  if (!await claimForJudging(workId)) return res.status(409)...;
  await recordExternalCall(workId, res.locals.feeUsdc ?? 0); // real fee, summed on /proof
  const result = await runVerdict(task, artifact);
  res.json({ workId, verdict: result.verdict.verdict, outcome: result.outcome, txHash: result.txHash });
});
```

---

## Tech Stack
| Layer | Technology |
|-------|-----------|
| Web | Next.js 15 (App Router), React 19, SSE |
| Verdict worker | Node + Express, Docker sandbox (network-isolated), viem |
| Reasoner | Anthropic Claude (pluggable model) over routed evidence |
| Static analysis | Semgrep, Bandit (in-sandbox) |
| Contracts | Solidity + Foundry (`VerdiktEscrow`) |
| Payments | Circle DCW, x402, Gateway; USDC on Arc |
| Chain | Arc testnet (chainId 5042002) |

---

## Testing

```bash
# Worker (verdict engine + real Docker sandbox)
cd worker && npm test          # 78/78 passing

# Contracts (escrow invariants, access control, reentrancy, front-run, sweep)
cd contracts && forge test     # 34/34 passing

# Root integration (schema + on-chain code maps + web↔worker hash parity)
npm test                       # 9/9 passing
```

The worker suite runs real code through the sandbox: a SQL-injection solution is caught by Bandit `B608` and a failed payer test, a clean solution produces zero static findings, prompt injection in code comments cannot make bad code pass, the deterministic floor fails on every route, and a crashed static scanner fails closed (abstain, never a false release). The contract suite proves the escrow reverts on double-settle, settle-before-fund, and non-verdict callers, is reentrancy safe, resists the EIP-3009 funding front-run, derives the outcome from the verdict code, and lets `sweep()` recover only stray balance, never escrowed principal.

### Try it: pay for a verdict (public x402)
The verdict API is a real paid endpoint. A worker funds an escrow, signs its artifact, and pays the sub-cent fee through Circle Gateway:

```bash
# 1. deposit the worker's Gateway balance once
WORKER_GATEWAY_KEY=… tsx scripts/gateway-buyer.ts deposit 0.05
# 2. fund an escrow for the task, then POST the signed artifact to /api/verdict.
#    A call with no Payment-Signature returns 402; the Gateway client pays and retries.
#    The settled fee is summed live on /proof (third-party paid calls only).
```

This exact path was exercised end to end against the live worker: deposit → 402 → Gateway settle → worker-signature check → single-shot judge → on-chain settle, with the fee recorded in the `/proof` counter.

---

## Smart Contracts
| Contract | Address | Chain | Description |
|----------|---------|-------|-------------|
| `VerdiktEscrow` | `0x8140FD0D07dB598fc04A284Ee5210C835a911Ae5` | Arc testnet (5042002) | Holds the escrow, settles release/refund/abstain, anchors `keccak256(evidence)` on-chain |

## On-Chain Verification
Every settlement is a real Arc transaction that moves USDC. A few from the live triad (explorer: `testnet.arcscan.app`):

| Outcome | Transaction |
|---------|-------------|
| Bad code to refund | `0xf89bb5c801ca714208d62217e575d1fbeacb94036c3a75055bc272c7696ebb02` |
| Good code to release | `0xd1d4d74d0f0af5d9...` (worker balance increases by the escrow amount) |
| Unsupported to abstain | `0x2abbcbf1289dbe6f03c62fd15026cb33a5919bec4b1ca53b02d58575d7786cf3` |

The escrow's `getEscrow(workId).evidenceHash` equals the signed receipt hash equals `keccak256` of the stored evidence bundle, so any verdict is independently verifiable.

---

## Running Locally

```bash
git clone https://github.com/dmustapha/verdikt-arc.git
cd verdikt-arc

# 1. Contracts
cd contracts && forge build && cd ..

# 2. Verdict worker (needs Docker for the code sandbox)
cd worker && npm install && npm run build
docker build -t verdikt-runner sandbox
PORT=8080 node --env-file=../.env dist/server.js   # worker on :8080

# 3. Web (separate terminal)
cd web && npm install && npm run dev                # app on :3000
```

The worker reads configuration from the process environment (no dotenv); pass it with `--env-file` locally or as platform secrets in production. The web app calls the worker through `WORKER_URL`.

### Required Environment Variables
| Variable | Description |
|----------|-------------|
| `ARC_RPC_URL` | Arc testnet RPC endpoint |
| `ESCROW_ADDRESS` | Deployed `VerdiktEscrow` address |
| `ANTHROPIC_API_KEY` | Reasoner model access |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_ID` | Circle DCW settlement |
| `DEMO_PAYER_KEY`, `DEMO_WORKER_KEY` | Demo agent signers (EIP-3009 funding) |
| `DEMO_SHARED_SECRET` | Guards the demo trigger route |
| `WORKER_URL` | Web to worker URL (web env) |
| `ENFORCE_X402` | `true` to require the Gateway fee on `/api/verdict` |

See `.env.example` for the full list.

---

## Project Structure
```
verdikt-arc/
  contracts/        # Foundry: VerdiktEscrow.sol + tests
  worker/           # Node verdict engine
    src/engine/     #   route selection, code/schema/grounding evaluators, reasoner, floor
    src/settlement/ #   EIP-3009 funding + Circle DCW settle
    src/routes/     #   /api/verdict (x402), /api/demo, /api/stream (SSE)
    sandbox/        #   network-isolated Docker runner image
  web/              # Next.js app
    src/app/        #   / landing, /courtroom, /proof, /ledger
  fixtures/         # demo tasks (code, schema, answer)
  scripts/          # seed, gateway buyer, agents
```

---

## Network
Arc testnet. Chain ID `5042002`. RPC `https://rpc.testnet.arc.network`. Explorer `https://testnet.arcscan.app`. Gas is paid in USDC; USDC is at `0x3600000000000000000000000000000000000000`.

## License
MIT
