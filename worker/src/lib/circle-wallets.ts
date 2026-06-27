import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

let _client: ReturnType<typeof initiateDeveloperControlledWalletsClient> | null = null;
function getClient() {
  if (!_client) {
    _client = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    });
  }
  return _client;
}

// POST /transactions/contractExecution — returns a Circle tx id (not the Arc tx hash).
export async function executeContractCall(params: {
  contractAddress: string;
  abiFunctionSignature: string;
  abiParameters: (string | number)[];
}): Promise<string> {
  const client = getClient();
  const res = await client.createContractExecutionTransaction({
    walletId: process.env.CIRCLE_WALLET_ID!,
    contractAddress: params.contractAddress,
    abiFunctionSignature: params.abiFunctionSignature,
    abiParameters: params.abiParameters.map(String),
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  return res.data!.id!;
}

// Poll the Circle tx id until it resolves to an Arc tx hash (or fails).
export async function waitForTxHash(circleTxId: string): Promise<`0x${string}` | null> {
  const client = getClient();
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await client.getTransaction({ id: circleTxId });
    const tx = res.data!.transaction;
    if (tx?.state === 'COMPLETE' && tx.txHash) return tx.txHash as `0x${string}`;
    if (tx?.state === 'FAILED' || tx?.state === 'CANCELLED') return null;
  }
  return null;
}
