import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Facilitator } from '@x402/core/facilitator';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';

// Self-hosted x402 v2 facilitator on Arc. No public facilitator supports Arc (chainId 5042002), so
// Verdikt runs its own: it VERIFIES an EIP-3009 toll authorization and SETTLES it ON-CHAIN (the settler
// wallet submits transferWithAuthorization, paying gas — on Arc gas IS USDC). Exposes the canonical x402
// facilitator HTTP contract the resource-server's HTTPFacilitatorClient calls:
//   POST /verify    { x402Version, paymentPayload, paymentRequirements } -> { isValid, invalidReason?, payer? }
//   POST /settle    (same body)                                          -> { success, transaction, network, payer? }
//   GET  /supported                                                      -> { kinds, extensions, signers }
// This is a Circle-depth differentiator: an x402 rail settling on Arc that literally does not exist publicly.

const ARC_CHAIN_ID = 5042002;
const ARC_NETWORK = `eip155:${ARC_CHAIN_ID}` as const;

const arc = defineChain({
  id: ARC_CHAIN_ID, name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network'] } },
  testnet: true,
});

function buildFacilitator(): x402Facilitator {
  const key = process.env.X402_SETTLER_KEY as `0x${string}` | undefined;
  if (!key) throw new Error('X402_SETTLER_KEY required (the funded Arc settler wallet)');
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain: arc, transport: http(process.env.ARC_RPC_URL) });
  const wallet = createWalletClient({ account, chain: arc, transport: http(process.env.ARC_RPC_URL) });

  // A FacilitatorEvmSigner over the two viem clients: reads via the public client, writes (the on-chain
  // toll settlement) via the wallet client. The settler (account) pays gas (USDC on Arc). Cast the viem
  // return types to the SDK's structural interface — viem supplies every method it needs.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    readContract: (args: any) => pub.readContract(args),
    verifyTypedData: (args: any) => pub.verifyTypedData(args),
    writeContract: (args: any) => wallet.writeContract({ account, chain: arc, ...args }),
    sendTransaction: (args: any) => wallet.sendTransaction({ account, chain: arc, ...args }),
    waitForTransactionReceipt: (args: any) => pub.waitForTransactionReceipt(args),
    getCode: (args: any) => pub.getCode(args),
  } as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const facilitator = new x402Facilitator();
  registerExactEvmScheme(facilitator, { signer, networks: ARC_NETWORK });
  return facilitator;
}

export function buildApp(facilitator: x402Facilitator): express.Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // Auth gate for the money-touching routes. /settle submits an on-chain tx paying gas from OUR settler
  // wallet, so an unauthenticated /settle is an open relay draining our gas. Require a shared key on
  // /verify + /settle (allowlisted callers = our own x402 sellers). /supported + /health stay public
  // (read-only discovery + the Fly health probe). Absent secret ⇒ auth disabled (local dev only), logged.
  const SECRET = process.env.X402_FACILITATOR_SECRET;
  if (!SECRET) console.warn('[x402-facilitator] X402_FACILITATOR_SECRET unset — /verify /settle are UNAUTHENTICATED (dev only)');
  const requireKey: express.RequestHandler = (req, res, next) => {
    if (!SECRET) return next(); // dev
    const provided = req.get('x-facilitator-key');
    if (!provided || !safeEqual(provided, SECRET)) { res.status(401).json({ error: 'unauthorized' }); return; }
    next();
  };

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'verdikt-x402-facilitator', network: ARC_NETWORK, authed: !!SECRET }));

  app.get('/supported', async (_req, res) => {
    try { res.json(await facilitator.getSupported()); }
    catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'supported failed' }); }
  });

  app.post('/verify', requireKey, async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body as { paymentPayload: unknown; paymentRequirements: unknown };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res.json(await facilitator.verify(paymentPayload as any, paymentRequirements as any));
    } catch (e) { res.status(400).json({ isValid: false, invalidReason: 'facilitator_error', invalidMessage: e instanceof Error ? e.message : 'verify failed' }); }
  });

  app.post('/settle', requireKey, async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body as { paymentPayload: unknown; paymentRequirements: unknown };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res.json(await facilitator.settle(paymentPayload as any, paymentRequirements as any));
    } catch (e) { res.status(400).json({ success: false, errorReason: 'facilitator_error', errorMessage: e instanceof Error ? e.message : 'settle failed', transaction: '', network: ARC_NETWORK }); }
  });

  return app;
}

// Constant-time key compare (different lengths ⇒ not equal, no early-exit timing leak).
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const app = buildApp(buildFacilitator());
  const port = Number(process.env.PORT ?? 8081);
  app.listen(port, () => console.log(`[x402-facilitator] listening on :${port} (network ${ARC_NETWORK})`));
}
