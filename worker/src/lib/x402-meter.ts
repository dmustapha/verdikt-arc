import type { Request, Response, NextFunction } from 'express';

const FACILITATOR_URL = 'https://gateway-api-testnet.circle.com';
const TESTNET_GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const ARC_NETWORK = 'eip155:5042002';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const VERDICT_FEE_USDC = parseFloat(process.env.VERDICT_FEE_USDC ?? '0.001'); // sub-cent

function build402(req: Request, res: Response) {
  const payTo = process.env.VERDICT_FEE_WALLET_ADDRESS!;
  const amountUnits = Math.round(VERDICT_FEE_USDC * 1_000_000).toFixed(0);
  const paymentRequired = {
    x402Version: 2,
    resource: { url: `${req.protocol}://${req.get('host')}${req.originalUrl}`, description: 'verdict', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact', network: ARC_NETWORK, asset: ARC_USDC, amount: amountUnits, payTo,
      maxTimeoutSeconds: 604900,
      extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: TESTNET_GATEWAY_WALLET },
    }],
  };
  res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(paymentRequired)).toString('base64'));
  res.status(402).json({ error: 'Payment required', fee_usdc: VERDICT_FEE_USDC, currency: 'USDC', chain: 'arcTestnet' });
}

async function settleViaGateway(header: string): Promise<{ ok: boolean; txHash?: string; error?: string }> {
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

  const settle = await fetch(`${FACILITATOR_URL}/v1/x402/settle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }),
  });
  if (!settle.ok) return { ok: false, error: `settle ${settle.status}` };
  const sr = (await settle.json()) as { success?: boolean; transaction?: string; errorReason?: string };
  if (!sr.success) return { ok: false, error: sr.errorReason ?? 'settle failed' };
  return { ok: true, txHash: sr.transaction };
}

// Express middleware: 402 unless a valid Payment-Signature is present. ENFORCE_X402=false
// skips metering for internal/demo runs (the /api/demo route is never metered).
export async function requireVerdictFee(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (process.env.ENFORCE_X402 === 'false') { res.locals.feeUsdc = 0; return next(); }
  const header = req.header('Payment-Signature') ?? req.header('X-Payment');
  if (!header) return build402(req, res);
  const result = await settleViaGateway(header);
  if (!result.ok) { res.status(402).json({ error: `x402 fee not settled: ${result.error}` }); return; }
  res.locals.feeUsdc = VERDICT_FEE_USDC;
  res.locals.feeTxHash = result.txHash ?? null;
  next();
}

export { VERDICT_FEE_USDC };
