import { privateKeyToAccount } from 'viem/accounts';
import type { Account } from 'viem';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import type {
  Acceptance, Artifact, ArtifactType, SignedTaskOffer, TaskOffer, VerdictResult, VerdiktConfig,
} from './types.js';
import { artifactMessage, criteriaHash, signOffer, verifyOffer } from './crypto.js';
import { ARC_CHAIN_ID, fundEscrow, readEscrow } from './escrow.js';
import {
  AlreadyJudgedError, ArtifactSignatureError, EscrowNotFundedError, InvalidOfferError, PaymentError,
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
}

class SellerApi {
  constructor(private vk: Verdikt) {}

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
  }): Promise<VerdictResult> {
    const { offer } = params.offer;
    if (!params.skipVerify) await this.acceptOffer(params.offer, { expectedAcceptance: params.expectedAcceptance });

    const sig = await this.vk._account.signMessage!({ message: artifactMessage(offer.workId, params.artifact.payload) });
    const body = { workId: offer.workId, artifact: { ...params.artifact, sig } };

    let data: { workId: `0x${string}`; verdict: string; outcome: string; txHash: string | null; feeUsdc?: number };
    try {
      data = (await this.vk._gateway.pay<typeof data>(`${this.vk._endpoint}/api/verdict`, { method: 'POST', body })).data;
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (msg.includes('already judged') || msg.includes('not in funded state')) throw new AlreadyJudgedError();
      if (msg.includes('does not match the task worker') || msg.includes('seller')) throw new ArtifactSignatureError();
      if (msg.includes('not authorized') || msg.includes('not paid') || msg.includes('balance') || msg.includes('402')) throw new PaymentError(msg.slice(0, 160));
      throw err;
    }

    const outcome = data.outcome as VerdictResult['outcome'];
    const status = outcome === 'release' ? 'released' : outcome === 'refund' ? 'refunded' : 'abstained';
    return {
      status, verdict: data.verdict as VerdictResult['verdict'], outcome,
      workId: data.workId, settlementTx: data.txHash ?? null, feeUsdc: data.feeUsdc ?? 0,
    };
  }
}
