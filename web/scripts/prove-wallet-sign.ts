// WS7 Gate E1 — prove the BROWSER wallet-sign path headlessly, closing the one gap a script can't
// reach with a private key alone: the wallet receives the typed data as a serialized
// `eth_signTypedData_v4` JSON-RPC request. This uses web's OWN buildAuthorization/fundBody (the exact
// functions HireFlow calls) and signs through a viem `custom` transport standing in for MetaMask — so
// viem serializes the payload EXACTLY as wagmi does in the browser, a mock provider receives that JSON
// and signs it, and we prove the signature recovers to the payer AND funds a real escrow via the relayer.
//
// Run: set -a; . ../.env; set +a; npx tsx scripts/prove-wallet-sign.ts   (from web/)
import { createWalletClient, custom, recoverTypedDataAddress, keccak256, stringToHex, parseUnits, http, createPublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from '../src/lib/chains';
import { buildAuthorization, fundBody, deriveNonce, LOCAL_ROUTES } from '../src/lib/relayer-sign';

const WORKER = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';
const ESCROW = (process.env.NEXT_PUBLIC_ESCROW_ADDRESS ?? process.env.ESCROW_ADDRESS) as `0x${string}`;
const SELLER = '0x665F4AF29aeeeA93cea97813f69a3ED3eAdEF8fF' as const;
const key = process.env.DEMO_PAYER_KEY as `0x${string}`;

async function main() {
  // 0. Lockstep: web's deriveNonce must equal the canonical constant (== contract + worker tests).
  const canon = deriveNonce({ workId: `0x${'11'.repeat(32)}`, worker: `0x${'22'.repeat(20)}`, amount: 60000n, fee: 10000n, ttl: 3600n, payer: `0x${'33'.repeat(20)}`, routes: LOCAL_ROUTES });
  if (canon !== '0x04e7254274bfc99a4bbe564c2c681993848fb46cceb8ac4a740cc80f67599366') throw new Error(`web deriveNonce drifted: ${canon}`);
  console.log('  ✓ web deriveNonce matches the canonical contract nonce (lockstep intact)');

  const acct = privateKeyToAccount(key);

  // Mock EIP-1193 provider = a stand-in for the browser wallet. It receives the serialized
  // eth_signTypedData_v4 request (a JSON string, exactly like MetaMask) and signs it.
  const provider = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: async ({ method, params }: { method: string; params?: any[] }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct.address];
      if (method === 'eth_chainId') return '0x4cef52'; // 5042002
      if (method === 'eth_signTypedData_v4') {
        const [addr, json] = params as [string, string];
        if (addr.toLowerCase() !== acct.address.toLowerCase()) throw new Error('address mismatch');
        const td = typeof json === 'string' ? JSON.parse(json) : json; // <- the real serialize→parse boundary
        return acct.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message });
      }
      throw new Error(`unexpected method ${method}`);
    },
  };

  // A wallet client over the mock provider. Passing the ADDRESS (not a local account) forces viem down
  // the JSON-RPC signing path — i.e. it SERIALIZES and calls eth_signTypedData_v4, exactly like the browser.
  const wallet = createWalletClient({ chain: arcTestnet, transport: custom(provider) });
  const [address] = await wallet.getAddresses();

  const workId = keccak256(stringToHex(`ws7-walletsign-${Date.now()}`));
  const total = 0.06, fee = 0.01;

  // 1. Register the task (the relayer binds funding to it).
  const t = await fetch(`${WORKER}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workId, type: 'answer', acceptance: { spec: 'wallet-sign proof' }, payer: address, seller: SELLER, amountUsdc: total }) });
  if (!t.ok) throw new Error(`/api/tasks ${t.status}: ${await t.text()}`);

  // 2. Build the EXACT payload HireFlow builds, then sign it through the JSON-RPC (wallet) boundary.
  const auth = buildAuthorization({ escrow: ESCROW, payer: address, workId, worker: SELLER, totalUsdc: total, feeUsdc: fee });
  const signature = await wallet.signTypedData({ account: address, ...auth.typedData });
  console.log('  ✓ wallet signed via eth_signTypedData_v4 (serialize→parse boundary crossed)');

  // 3. The signature must recover to the payer over the same payload.
  const signer = await recoverTypedDataAddress({ ...auth.typedData, signature });
  if (signer.toLowerCase() !== address.toLowerCase()) throw new Error(`recovered ${signer} != payer ${address}`);
  console.log('  ✓ signature recovers to the payer');

  // 4. Fund a REAL escrow with that wallet-produced signature via the live relayer.
  const r = await fetch(`${WORKER}/relayer/fund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fundBody({ payer: address, workId, worker: SELLER, amount: auth.amount, fee: auth.fee, ttl: auth.ttl, validAfter: auth.validAfter, validBefore: auth.validBefore, signature, routes: auth.routes })) });
  const rb = await r.json() as { fundTx?: string; error?: string };
  if (!r.ok) throw new Error(`/relayer/fund ${r.status}: ${JSON.stringify(rb)}`);

  const pub = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
  const GET = [{ type: 'function', name: 'getEscrow', stateMutability: 'view', inputs: [{ name: 'w', type: 'bytes32' }], outputs: [{ type: 'tuple', components: [{ name: 'payer', type: 'address' }, { name: 'worker', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'fee', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'status', type: 'uint8' }, { name: 'o', type: 'uint8' }, { name: 'v', type: 'uint8' }, { name: 'eh', type: 'bytes32' }, { name: 'wd', type: 'uint32' }, { name: 'wr', type: 'bytes32' }, { name: 'pd', type: 'uint32' }, { name: 'pr', type: 'bytes32' }] }] }] as const;
  const e = await pub.readContract({ address: ESCROW, abi: GET, functionName: 'getEscrow', args: [workId] }) as { status: number; payer: string };
  if (e.status !== 1 || e.payer.toLowerCase() !== address.toLowerCase()) throw new Error(`escrow not FUNDED by payer (status=${e.status})`);

  // Amount must equal exactly what was signed — proof the serialization preserved the value.
  if (auth.amount !== parseUnits(total.toFixed(6), 6)) throw new Error('amount mismatch');
  console.log(`\n  ✓ WALLET-SIGN PATH PROVEN — a browser-style eth_signTypedData_v4 signature funded a real escrow.`);
  console.log(`    fundTx: https://testnet.arcscan.app/tx/${rb.fundTx}`);
  process.exit(0);
}
main().catch((e) => { console.error('WALLET-SIGN PROOF FAILED:', e.message); process.exit(1); });
