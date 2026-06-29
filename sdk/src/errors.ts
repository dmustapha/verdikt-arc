// Typed error taxonomy (Stripe-style): the SDK surfaces these instead of raw HTTP codes so callers
// can branch precisely. Auto-handled internally: 402 (pay), SSE plumbing, typed-data construction.

export class VerdiktError extends Error {
  constructor(message: string) { super(message); this.name = 'VerdiktError'; }
}

// The escrow named in an offer is not actually funded on-chain (or wrong seller/amount). The seller
// MUST get this before doing work — it means the job isn't really backed.
export class EscrowNotFundedError extends VerdiktError {
  constructor(public readonly workId: string, detail: string) {
    super(`escrow not funded for ${workId}: ${detail}`); this.name = 'EscrowNotFundedError';
  }
}

// The offer signature is invalid/expired or the criteriaHash does not match the registered task.
export class InvalidOfferError extends VerdiktError {
  constructor(reason: string) { super(`invalid task offer: ${reason}`); this.name = 'InvalidOfferError'; }
}

// The worker rejected the artifact signature (HTTP 403) — the signer is not the task's seller.
export class ArtifactSignatureError extends VerdiktError {
  constructor() { super('artifact signature does not match the task seller'); this.name = 'ArtifactSignatureError'; }
}

// The escrow was already judged/settled (HTTP 409). Idempotent: the original verdict is attached.
export class AlreadyJudgedError extends VerdiktError {
  constructor(public readonly original?: unknown) {
    super('escrow already judged (replay)'); this.name = 'AlreadyJudgedError';
  }
}

// The Gateway fee could not be authorized (HTTP 402 after a pay attempt) — usually no balance.
export class PaymentError extends VerdiktError {
  constructor(detail: string) { super(`verdict fee not paid: ${detail}`); this.name = 'PaymentError'; }
}
