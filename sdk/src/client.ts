import { privateKeyToAccount } from 'viem/accounts';
import type { Account } from 'viem';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import type {
  Acceptance, Artifact, ArtifactType, SignedTaskOffer, TaskOffer, VerdictResult, VerdictStep, VerdiktConfig,
} from './types.js';
import { artifactMessage, criteriaHash, signOffer, verifyOffer } from './crypto.js';
import { ARC_CHAIN_ID, fundEscrow, readEscrow } from './escrow.js';
import { fundCrossChainEscrow, type CrossChainConfig, type PayoutRoute, type PayoutRoutes } from './crosschain.js';
import {
  AlreadyJudgedError, ArtifactSignatureError, EscrowNotFundedError, InvalidOfferError, OnboardingError, PaymentError,
} from './errors.js';

const STATUS_FUNDED = 1;

function randomWorkId(): `0x${string}` {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

function nowMs(): number { return Date.now(); }

// One pluggable signer for an agent. MVP: a raw private key (also feeds the Gateway client). CDP /
// Circle Developer-Controlled Wallets / ERC-4337 session keys are the documented v2 upgrade — they
// slot in behind this same `signer` shape.
export interface VerdiktSigner { privateKey: `0x${string}`; }

export class Verdikt {
  private account: Account;
  private gateway: GatewayClient;
  readonly payer: PayerApi;
  readonly seller: SellerApi;

  constructor(private config: VerdiktConfig & { signer: VerdiktSigner }) {
    this.account = privateKeyToAccount(config.signer.privateKey);
    this.gateway = new GatewayClient({ chain: 'arcTestnet', privateKey: config.signer.privateKey });
    this.payer = new PayerApi(this);
    this.seller = new SellerApi(this);
  }

  /** @internal */ get _account() { return this.account; }
  /** @internal */ get _endpoint() { return this.config.endpoint.replace(/\/$/, ''); }
  /** @internal */ get _rpcUrl() { return this.config.rpcUrl; }
  /** @internal */ get _gateway() { return this.gateway; }

  /**
   * @internal Subscribe to the worker's SSE step stream for a workId and forward each step to `onStep`.
   * Portable (fetch + stream reader, no EventSource dependency). Best-effort: network/parse errors are
   * swallowed since steps are for legibility, not correctness. Returns a stop function.
   */
  _streamSteps(workId: string, onStep: (s: VerdictStep) => void): () => void {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${this._endpoint}/api/stream/${workId}`, { signal: ctrl.signal, headers: { accept: 'text/event-stream' } });
        if (!res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            try { onStep(JSON.parse(line.slice(5).trim()) as VerdictStep); } catch { /* skip partial */ }
          }
        }
      } catch { /* aborted or transient — steps are best-effort */ }
    })();
    return () => ctrl.abort();
  }
}

class PayerApi {
  constructor(private vk: Verdikt) {}

  /**
   * Open a verified-payment job in ONE call: register the acceptance criteria, fund the escrow
   * on-chain (EIP-3009), and return a payer-signed Task Offer to hand an independent seller.
   */
  async createTask(params: {
    type: ArtifactType;
    acceptance: Acceptance;
    amountUsdc: number;
    seller: `0x${string}`;
    expiresInSeconds?: number;
  }): Promise<{ workId: `0x${string}`; offer: SignedTaskOffer; escrowTx: `0x${string}`; criteriaHash: `0x${string}` }> {
    const payer = this.vk._account.address as `0x${string}`;
    const workId = randomWorkId();

    // 1. Register criteria (public on-ramp). Returns the canonical criteriaHash + escrow address.
    const res = await fetch(`${this.vk._endpoint}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workId, type: params.type, acceptance: params.acceptance, payer, seller: params.seller, amountUsdc: params.amountUsdc }),
    });
    if (!res.ok) throw new Error(`createTask: /api/tasks ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const reg = (await res.json()) as { criteriaHash: `0x${string}`; escrow: `0x${string}`; chainId: number; feeUsdc: number };

    // Defense: confirm the server committed to the criteria we sent (no silent swap).
    const localHash = criteriaHash(params.acceptance);
    if (reg.criteriaHash.toLowerCase() !== localHash.toLowerCase()) {
      throw new InvalidOfferError(`server criteriaHash ${reg.criteriaHash} != local ${localHash}`);
    }

    // 2. Fund the escrow on-chain (EIP-3009).
    const escrowTx = await fundEscrow({
      account: this.vk._account, escrow: reg.escrow, workId, seller: params.seller,
      amountUsdc: params.amountUsdc, rpcUrl: this.vk._rpcUrl, nowMs: nowMs(),
    });

    // 3. Build + sign the Task Offer.
    const offer: TaskOffer = {
      workId, type: params.type, criteriaHash: reg.criteriaHash, amountUsdc: params.amountUsdc,
      escrow: reg.escrow, payer, seller: params.seller, chainId: reg.chainId ?? ARC_CHAIN_ID,
      feeUsdc: reg.feeUsdc, expiresAt: Math.floor(nowMs() / 1000) + (params.expiresInSeconds ?? 3600),
    };
    const signature = await signOffer(this.vk._account, offer);
    return { workId, offer: { offer, signature }, escrowTx, criteriaHash: reg.criteriaHash };
  }

  /**
   * X1: open a verified-payment job funded from ANOTHER chain (Base Sepolia) over Circle CCTP V2.
   * Same shape as createTask, but step 2 burns USDC on the source chain → Iris attests → the Arc
   * EscrowFundingHook mints + funds the escrow. The escrow ends up holding the FEE-NET amount (Fast
   * Transfer deducts a small fee), so we read the on-chain amount and sign the offer with it — that
   * keeps acceptOffer's strict amount check intact. The payer key must hold USDC + gas on Base
   * Sepolia (faucet.circle.com). Returns both explorer legs (source burn + Arc fund).
   */
  async createTaskCrossChain(params: {
    type: ArtifactType;
    acceptance: Acceptance;
    amountUsdc: number;
    seller: `0x${string}`;
    crossChain: CrossChainConfig;
    /** Where the seller is paid OUT on a release (their home chain). Omit = paid on Arc. */
    sellerPayout?: PayoutRoute;
    /** Where the buyer is refunded on a refund/abstain (their home chain). Omit = refunded on Arc. */
    payerRefund?: PayoutRoute;
    maxFeeUsdc?: number;
    expiresInSeconds?: number;
    onStep?: (step: string) => void;
  }): Promise<{
    workId: `0x${string}`; offer: SignedTaskOffer; burnTxHash: `0x${string}`;
    fundTxHash: `0x${string}`; criteriaHash: `0x${string}`; escrowedUsdc: number;
  }> {
    const payer = this.vk._account.address as `0x${string}`;
    const workId = randomWorkId();

    // 1. Register criteria (same on-ramp as createTask).
    const res = await fetch(`${this.vk._endpoint}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workId, type: params.type, acceptance: params.acceptance, payer, seller: params.seller, amountUsdc: params.amountUsdc }),
    });
    if (!res.ok) throw new Error(`createTaskCrossChain: /api/tasks ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const reg = (await res.json()) as { criteriaHash: `0x${string}`; escrow: `0x${string}`; chainId: number; feeUsdc: number };

    const localHash = criteriaHash(params.acceptance);
    if (reg.criteriaHash.toLowerCase() !== localHash.toLowerCase()) {
      throw new InvalidOfferError(`server criteriaHash ${reg.criteriaHash} != local ${localHash}`);
    }

    // 2. Fund the escrow cross-chain (source chain → Arc via CCTP V2), carrying the payout routes so
    //    the seller/buyer can be paid OUT to their home chains on settlement.
    const routes: PayoutRoutes = { worker: params.sellerPayout, payer: params.payerRefund };
    const { burnTxHash, fundTxHash } = await fundCrossChainEscrow({
      account: this.vk._account, amountUsdc: params.amountUsdc, workId, payer, worker: params.seller,
      routes, config: params.crossChain, maxFeeUsdc: params.maxFeeUsdc, onStep: params.onStep,
    });

    // 3. Read the ACTUAL net-of-fee amount the escrow holds, and sign the offer with it.
    const e = await readEscrow(reg.escrow, workId, this.vk._rpcUrl);
    const escrowedUsdc = Number(e.amount) / 1e6;

    const offer: TaskOffer = {
      workId, type: params.type, criteriaHash: reg.criteriaHash, amountUsdc: escrowedUsdc,
      escrow: reg.escrow, payer, seller: params.seller, chainId: reg.chainId ?? ARC_CHAIN_ID,
      feeUsdc: reg.feeUsdc, expiresAt: Math.floor(nowMs() / 1000) + (params.expiresInSeconds ?? 3600),
    };
    const signature = await signOffer(this.vk._account, offer);
    return { workId, offer: { offer, signature }, burnTxHash, fundTxHash, criteriaHash: reg.criteriaHash, escrowedUsdc };
  }
}

class SellerApi {
  constructor(private vk: Verdikt) {}

  // ── A2: Circle Gateway onboarding ──────────────────────────────────────────────────────────────
  // A seller pays the sub-cent x402 verdict fee out of its Circle Gateway balance. A fresh seller has
  // none, so submit() would 402. These three methods let a seller self-fund: gatewayBalance() inspects
  // it, depositFee() tops it up via the Gateway deposit (approve + deposit — the ONLY funding path; a
  // raw transfer to the Gateway wallet would burn the funds), and ensureOnboarded() makes submit()
  // genuinely one-call after a one-time, idempotent setup.

  /** Inspect the seller's balances: Gateway available/total (spendable on fees) + raw wallet USDC. */
  async gatewayBalance(): Promise<{ availableUsdc: number; totalUsdc: number; walletUsdc: number }> {
    const b = await this.vk._gateway.getBalances();
    return {
      availableUsdc: Number(b.gateway.available) / 1e6,
      totalUsdc: Number(b.gateway.total) / 1e6,
      walletUsdc: Number(b.wallet.balance) / 1e6,
    };
  }

  /**
   * Deposit USDC from the seller's wallet into its Circle Gateway balance (approve + deposit in one
   * call). Throws OnboardingError with the actionable next step if the wallet can't cover the deposit.
   * NOTE: `availableUsdc` is read right after the deposit and Circle's Gateway balance is
   * eventually-consistent (a few seconds), so it may not yet reflect this deposit — `depositTxHash`
   * is the authoritative on-chain proof.
   */
  async depositFee(amountUsdc: number): Promise<{ depositTxHash: string; approvalTxHash?: string; depositedUsdc: number; availableUsdc: number }> {
    if (!(amountUsdc > 0)) throw new OnboardingError(`deposit amount must be > 0 (got ${amountUsdc})`);
    const wallet = await this.vk._gateway.getUsdcBalance();
    const haveUsdc = Number(wallet.balance) / 1e6;
    if (haveUsdc < amountUsdc) {
      throw new OnboardingError(`seller wallet ${this.vk._gateway.address} holds ${haveUsdc} USDC but needs ${amountUsdc} to deposit — fund it at faucet.circle.com (Arc testnet) and retry`);
    }
    const r = await this.vk._gateway.deposit(String(amountUsdc));
    const bal = await this.gatewayBalance();
    return { depositTxHash: r.depositTxHash, approvalTxHash: r.approvalTxHash, depositedUsdc: Number(r.amount) / 1e6, availableUsdc: bal.availableUsdc };
  }

  /**
   * Idempotent onboarding: ensure the seller has at least `minUsdc` of spendable Gateway balance,
   * depositing `depositUsdc` if it's short. Safe to call before every submit() — a no-op once funded.
   * Returns whether a deposit was needed and the resulting available balance.
   */
  async ensureOnboarded(opts?: { minUsdc?: number; depositUsdc?: number }): Promise<{ onboarded: boolean; deposited: boolean; availableUsdc: number; depositTxHash?: string }> {
    const minUsdc = opts?.minUsdc ?? 0.01;
    const depositUsdc = opts?.depositUsdc ?? 0.05;
    const bal = await this.gatewayBalance();
    if (bal.availableUsdc >= minUsdc) return { onboarded: true, deposited: false, availableUsdc: bal.availableUsdc };
    // A returned depositFee means the deposit confirmed on-chain (it throws otherwise), so the seller
    // IS onboarded — don't gate on the eventually-consistent balance read, which can still be stale.
    const dep = await this.depositFee(depositUsdc);
    return { onboarded: true, deposited: true, availableUsdc: dep.availableUsdc, depositTxHash: dep.depositTxHash };
  }

  /**
   * Verify a Task Offer BEFORE doing any work: the payer's signature + expiry, AND that the escrow is
   * actually funded on-chain for this seller and amount. Throws InvalidOffer / EscrowNotFunded.
   * Optionally checks the criteriaHash against the criteria the seller intends to satisfy.
   */
  async acceptOffer(signed: SignedTaskOffer, opts?: { expectedAcceptance?: Acceptance }): Promise<TaskOffer> {
    const { offer, signature } = signed;
    const v = await verifyOffer(offer, signature, Math.floor(nowMs() / 1000));
    if (!v.ok) throw new InvalidOfferError(v.reason ?? 'invalid');

    if (opts?.expectedAcceptance) {
      const h = criteriaHash(opts.expectedAcceptance);
      if (h.toLowerCase() !== offer.criteriaHash.toLowerCase()) {
        throw new InvalidOfferError(`criteriaHash mismatch: offer ${offer.criteriaHash} != expected ${h}`);
      }
    }

    const e = await readEscrow(offer.escrow, offer.workId, this.vk._rpcUrl);
    if (e.status !== STATUS_FUNDED) throw new EscrowNotFundedError(offer.workId, `status=${e.status} (expected funded)`);
    if (e.worker.toLowerCase() !== offer.seller.toLowerCase()) throw new EscrowNotFundedError(offer.workId, 'escrow seller mismatch');
    const expected = BigInt(Math.round(offer.amountUsdc * 1e6));
    if (e.amount !== expected) throw new EscrowNotFundedError(offer.workId, `amount ${e.amount} != offered ${expected}`);
    return offer;
  }

  /**
   * Deliver + get judged in ONE call: verify the offer + escrow, sign the artifact, pay the x402
   * fee via Circle Gateway, and await the verdict. Returns a typed result. The fee is captured only
   * if a verdict is rendered (release/refund); abstain is free.
   */
  async submit(params: {
    offer: SignedTaskOffer; artifact: Artifact; expectedAcceptance?: Acceptance; skipVerify?: boolean;
    onStep?: (step: VerdictStep) => void;
  }): Promise<VerdictResult> {
    const { offer } = params.offer;
    if (!params.skipVerify) await this.acceptOffer(params.offer, { expectedAcceptance: params.expectedAcceptance });

    const sig = await this.vk._account.signMessage!({ message: artifactMessage(offer.workId, params.artifact.payload) });
    // B1: bind the submission to the offer's committed criteriaHash so the worker rejects judging if
    // the payer registered different criteria than it offered.
    const body = { workId: offer.workId, criteriaHash: offer.criteriaHash, artifact: { ...params.artifact, sig } };

    // Stream the verdict steps to the caller (the same SSE the courtroom watches), if requested.
    const stopStream = params.onStep ? this.vk._streamSteps(offer.workId, params.onStep) : undefined;

    let data: { workId: `0x${string}`; verdict: string; outcome: string; txHash: string | null; feeUsdc?: number };
    try {
      data = (await this.vk._gateway.pay<typeof data>(`${this.vk._endpoint}/api/verdict`, { method: 'POST', body })).data;
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (msg.includes('already judged') || msg.includes('not in funded state')) throw new AlreadyJudgedError();
      if (msg.includes('does not match the task worker') || msg.includes('seller')) throw new ArtifactSignatureError();
      if (msg.includes('not authorized') || msg.includes('not paid') || msg.includes('balance') || msg.includes('402')) throw new PaymentError(msg.slice(0, 160));
      throw err;
    } finally {
      // Give the reader a beat to flush the terminal 'settled' step, then stop.
      if (stopStream) setTimeout(stopStream, 1200);
    }

    const outcome = data.outcome as VerdictResult['outcome'];
    const status = outcome === 'release' ? 'released' : outcome === 'refund' ? 'refunded' : 'abstained';
    return {
      status, verdict: data.verdict as VerdictResult['verdict'], outcome,
      workId: data.workId, settlementTx: data.txHash ?? null, feeUsdc: data.feeUsdc ?? 0,
    };
  }
}
