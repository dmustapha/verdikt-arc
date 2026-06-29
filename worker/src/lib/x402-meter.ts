import type { Request, Response, NextFunction } from 'express';

const FACILITATOR_URL = 'https://gateway-api-testnet.circle.com';
const TESTNET_GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const ARC_NETWORK = 'eip155:5042002';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const VERDICT_FEE_USDC = parseFloat(process.env.VERDICT_FEE_USDC ?? '0.001'); // sub-cent

function build402(req: Request, res: Response) {
  const payTo = process.env.VERDICT_FEE_WALLET_ADDRESS!;
  const amountUnits = Math.round(VERDICT_FEE_USDC * 1_000_000).toFixed(0);
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  // The PAYMENT-REQUIRED header is the PROVEN Circle Gateway path: GatewayClient.supports() reads
  // base64(JSON).accepts from THIS header and matches on network + extra.{name,version,
  // verifyingContract}. Keep this object byte-identical to the proven shape — do not refactor it.
  const headerRequired = {
    x402Version: 2,
    resource: { url, description: 'verdict', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact', network: ARC_NETWORK, asset: ARC_USDC, amount: amountUnits, payTo,
      maxTimeoutSeconds: 604900,
      extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: TESTNET_GATEWAY_WALLET },
    }],
  };
  res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(headerRequired)).toString('base64'));

  // The BODY now carries the canonical x402 v2 PaymentRequirements shape so generic x402 clients and
  // discovery crawlers (which read `body.accepts`, not the header) can discover this rail. Standard
  // field names: `maxAmountRequired` (atomic), `resource` (string url), `asset`. `amount` is kept as
  // an alias for clients that read either. Human-friendly fee fields are additive.
  res.status(402).json({
    x402Version: 2,
    error: 'Payment required',
    accepts: [{
      scheme: 'exact',
      network: ARC_NETWORK,
      maxAmountRequired: amountUnits,
      amount: amountUnits,
      resource: url,
      description: 'Verdikt verdict on agent work',
      mimeType: 'application/json',
      payTo,
      maxTimeoutSeconds: 604900,
      asset: ARC_USDC,
      extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: TESTNET_GATEWAY_WALLET },
    }],
    fee_usdc: VERDICT_FEE_USDC,
    currency: 'USDC',
    chain: 'arcTestnet',
  });
}

interface PaymentAuthorization {
  payload: { accepted?: unknown };
  requirements: unknown;
}

// AUTHORIZE only — confirm the payment is valid via the facilitator's /verify, but DO NOT move funds
// yet. This is the Stripe-style "auth" half of auth-and-capture: we prove the caller can pay (so we
// never run an expensive verdict for a non-payer) without charging them before we know the outcome.
async function verifyViaGateway(header: string): Promise<{ ok: boolean; auth?: PaymentAuthorization; error?: string }> {
  let payload: { accepted?: unknown };
  try {
    payload = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
  } catch {
    return { ok: false, error: 'bad Payment-Signature' };
  }
  const requirements = payload.accepted;
  if (!requirements) return { ok: false, error: 'missing accepted requirements' };

  const verify = await fetch(`${FACILITATOR_URL}/v1/x402/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }),
  });
  if (!verify.ok) return { ok: false, error: `verify ${verify.status}` };
  const vr = (await verify.json()) as { isValid?: boolean; invalidReason?: string };
  if (!vr.isValid) return { ok: false, error: vr.invalidReason ?? 'invalid' };
  return { ok: true, auth: { payload, requirements } };
}

// CAPTURE — actually settle the fee via the facilitator's /settle. Called ONLY after a verdict was
// rendered (release/refund). The "capture" half of auth-and-capture.
async function captureViaGateway(auth: PaymentAuthorization): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  const settle = await fetch(`${FACILITATOR_URL}/v1/x402/settle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentPayload: auth.payload, paymentRequirements: auth.requirements }),
  });
  if (!settle.ok) return { ok: false, error: `settle ${settle.status}` };
  const sr = (await settle.json()) as { success?: boolean; transaction?: string; errorReason?: string };
  if (!sr.success) return { ok: false, error: sr.errorReason ?? 'settle failed' };
  return { ok: true, txHash: sr.transaction };
}

// Middleware: AUTHORIZE the fee (verify, don't charge). ENFORCE_X402=false skips metering entirely
// (internal/demo runs are never metered). On success, the verified authorization is stashed on
// res.locals for the route to CAPTURE later — but only if it renders a verdict.
export async function requireVerdictFee(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (process.env.ENFORCE_X402 === 'false') { res.locals.payment = null; return next(); }
  const header = req.header('Payment-Signature') ?? req.header('X-Payment');
  if (!header) return build402(req, res);
  const result = await verifyViaGateway(header);
  if (!result.ok) { res.status(402).json({ error: `x402 fee not authorized: ${result.error}` }); return; }
  res.locals.payment = result.auth; // authorized, not yet captured
  next();
}

// Capture the authorized fee. The route calls this ONLY when a verdict was rendered (release/refund)
// and settled on-chain — never on abstain. "If we couldn't verify, we don't take their money."
// Returns the fee actually charged (0 when there was no authorization, e.g. ENFORCE_X402=false).
export async function captureVerdictFee(res: Response): Promise<{ feeUsdc: number; txHash: string | null }> {
  const auth = res.locals.payment as PaymentAuthorization | null;
  if (!auth) return { feeUsdc: 0, txHash: null };
  const cap = await captureViaGateway(auth);
  if (!cap.ok) {
    // Never fabricate a charge; if capture fails, the caller is not billed.
    console.error(`[x402] fee capture failed: ${cap.error}`);
    return { feeUsdc: 0, txHash: null };
  }
  return { feeUsdc: VERDICT_FEE_USDC, txHash: cap.txHash ?? null };
}

export { VERDICT_FEE_USDC };
