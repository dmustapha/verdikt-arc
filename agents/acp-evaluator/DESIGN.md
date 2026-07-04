# WS12 — Verdikt as an ACP Evaluator (Virtuals, Base mainnet)

## The integration in one line
Verdikt registers as an ACP **Evaluator** agent; when an ACP job's deliverable is submitted, Verdikt
runs its **existing verdict engine** over the deliverable and calls `session.complete()` (pass) or
`session.reject()` (fail). Verdikt = the pluggable quality gate for a real on-chain agent marketplace.

## Confirmed facts (from @virtuals-protocol/acp-node-v2, 2026-07-04)
- **Chain:** Base **mainnet** (SDK default). Evaluator wallet needs a little Base ETH for gas. NO token launch required (service registration only).
- **Register:** app.virtuals.io/acp/new → creates the agent; app.virtuals.io/acp/agents/<id> → Signers/Settings.
- **Creds (in agents/acp-evaluator/.env):**
  - `ACP_WALLET_ADDRESS` = 0xed6c93b309477ebedd6717f94700f3c008470584 (Verdikt evaluator agent, Privy-managed; public)
  - `ACP_WALLET_ID` = (in .env; note: NOT UUID-shaped like the SDK example — verify on wiring)
  - `ACP_SIGNER_PRIVATE_KEY` = Privy **authorization key** (base64 PKCS#8 P-256, ~155 chars, starts `MIGH`), NOT an EOA key. From Signers → Add Signer → Copy Key. Policy "Virtuals-only" (safe). Dami holds it; drops into .env.
  - `ACP_BUILDER_CODE` (optional, Settings tab).
- **v2 API shape:**
  - `job.deliverable` (string|null), `job.evaluatorAddress`.
  - Evaluator acts on a `job.submitted` system event routed to role "evaluator" (evaluatorAddress == our wallet).
  - `session.complete(reason)` = approve · `session.reject(reason)` = reject.
  - Buyer selects third-party evaluation via `createJobFromOffering({ evaluatorAddress: <Verdikt wallet> })`.
  - Provider adapter: `PrivyAlchemyEvmProviderAdapter` (Privy-managed) or custom `IEvmProviderAdapter`.

## Architecture (reuse the ONE verdict engine)
```
ACP job.submitted (deliverable)
   │  agents/acp-evaluator (AcpClient v2, Verdikt wallet)
   ▼
  map deliverable + requirement → { type, acceptance, artifact }
   │  POST worker /api/evaluate   ← NEW: pure computeVerdict, NO Arc settle
   ▼
  { verdict: pass|fail|partial|abstain, rationale, evidenceHash }
   │  pass → session.complete(rationale) ; else → session.reject(rationale)
   ▼
  ACP settles on its own rails (Verdikt only JUDGES; it does not custody ACP funds)
```
Why a NEW `/api/evaluate` (not /try): /try calls runVerdict which SETTLES on Arc. An ACP job is not
escrowed on Arc, so Verdikt must only render a VERDICT, not move money. computeVerdict (WS11 extraction)
already does verify-without-settle — expose it over HTTP.

## Build steps
1. [ ] worker: `POST /api/evaluate` { type, acceptance, artifact } → computeVerdict → { verdict, rationale, evidenceHash, evidence }. No DB task, no settle. Rate-limited.
2. [ ] agents/acp-evaluator: judge core `judgeDeliverable(deliverable, requirement) → { approve, reason }` (POST /api/evaluate).
3. [ ] ACP wiring: AcpClient v2 init from .env; on job.submitted for our evaluator → judgeDeliverable → complete/reject.
4. [ ] Mock proof (no live wallet): simulated job.submitted → judge → complete/reject decision asserted.
5. [ ] LIVE job (Gate I1): needs a buyer+seller too (more Privy agents) OR an existing ACP job that names our evaluator. Document the live attempt; mock-adapter proof is the plan's accepted fallback.

## Honest boundary
Base mainnet + real gas. A full live job needs buyer+seller agents (extra setup) — until then, the
adapter is proven against an ACP-shaped mock (Gate I1 fallback per MASTER-PLAN PART 5).
