// WS12 — a raw-EOA provider adapter for Virtuals ACP (Base mainnet).
//
// The SDK ships PrivyAlchemyEvmProviderAdapter (smart-account, needs a registered Virtuals agent) and an
// abstract ViemProviderAdapter stub whose every method throws. To run a FULL live ACP job WITHOUT
// registering extra agents, we back the IEvmProviderAdapter with a plain viem private key (a normal EOA).
//
// The one subtlety: the ACP client executes every prepared operation through `sendCalls(chainId, calls)`
// (EvmAcpClient.execute). A smart account batches those calls atomically; an EOA cannot. We instead send
// each call as its own transaction and WAIT for its receipt before the next — which preserves ordering
// (this is what makes the buyer's approve-then-fund pair correct: the allowance is mined before fund pulls
// USDC). Reads and signing map straight onto a viem publicClient / account.
import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Address,
  type Call,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type TypedDataDefinition,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createEvmNetworkContext, type NetworkContext } from '@virtuals-protocol/acp-node-v2';
import type { GetLogsParams, IEvmProviderAdapter, ReadContractParams } from '@virtuals-protocol/acp-node-v2';

const BASE_CHAIN_ID = base.id; // 8453

// Normalize a viem Call (EIP-5792 shape) into a plain transaction request. ACP only ever emits calls with
// { to, data, value }, so that is all we forward.
function callToTx(call: Call): { to: Address; data: Hex; value: bigint } {
  const to = (call as { to?: Address }).to;
  if (!to) throw new Error('viem-adapter: call is missing a `to` address');
  return {
    to,
    data: ((call as { data?: Hex }).data ?? '0x') as Hex,
    value: (call as { value?: bigint }).value ?? 0n,
  };
}

export class ViemEoaProviderAdapter implements IEvmProviderAdapter {
  readonly providerName = 'viem-eoa';
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly publicClient: PublicClient<Transport, typeof base>;
  private readonly walletClient: WalletClient<Transport, typeof base, Account>;

  constructor(privateKey: Hex, rpcUrl = process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com') {
    this.account = privateKeyToAccount(privateKey);
    const transport = http(rpcUrl);
    this.publicClient = createPublicClient({ chain: base, transport });
    this.walletClient = createWalletClient({ account: this.account, chain: base, transport });
  }

  async getAddress(): Promise<Address> {
    return this.account.address;
  }

  async getSupportedChainIds(): Promise<number[]> {
    return [BASE_CHAIN_ID];
  }

  async getNetworkContext(chainId: number): Promise<NetworkContext> {
    return createEvmNetworkContext(chainId);
  }

  private assertChain(chainId: number): void {
    if (chainId !== BASE_CHAIN_ID) {
      throw new Error(`viem-adapter: only Base (${BASE_CHAIN_ID}) is supported, got ${chainId}`);
    }
  }

  // Send one call and wait for it to be mined; returns the tx hash.
  private async sendOne(call: Call): Promise<Address> {
    const tx = callToTx(call);
    const hash = await this.walletClient.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash as Address;
  }

  // ACP executes prepared ops via sendCalls. An EOA can't batch, so we send sequentially and wait for each
  // receipt (preserves approve→fund ordering). A single call returns its hash; multiple return an array.
  async sendCalls(chainId: number, calls: Call[]): Promise<Address | Address[]> {
    this.assertChain(chainId);
    const hashes: Address[] = [];
    for (const call of calls) hashes.push(await this.sendOne(call));
    return hashes.length === 1 ? hashes[0] : hashes;
  }

  async sendTransaction(chainId: number, call: Call | Call[]): Promise<Address> {
    this.assertChain(chainId);
    const calls = Array.isArray(call) ? call : [call];
    let last: Address = '0x' as Address;
    for (const c of calls) last = await this.sendOne(c);
    return last;
  }

  async getTransactionReceipt(chainId: number, hash: Address): Promise<TransactionReceipt> {
    this.assertChain(chainId);
    return this.publicClient.getTransactionReceipt({ hash });
  }

  async readContract(chainId: number, params: ReadContractParams): Promise<unknown> {
    this.assertChain(chainId);
    return this.publicClient.readContract({
      address: params.address,
      abi: params.abi as readonly unknown[],
      functionName: params.functionName,
      args: params.args as readonly unknown[] | undefined,
    } as Parameters<PublicClient['readContract']>[0]);
  }

  async getLogs(chainId: number, params: GetLogsParams): Promise<Log[]> {
    this.assertChain(chainId);
    return this.publicClient.getLogs({
      address: params.address,
      events: params.events,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
    } as Parameters<PublicClient['getLogs']>[0]);
  }

  async getBlockNumber(chainId: number): Promise<bigint> {
    this.assertChain(chainId);
    return this.publicClient.getBlockNumber();
  }

  async signMessage(chainId: number, message: string): Promise<string> {
    this.assertChain(chainId);
    return this.account.signMessage({ message });
  }

  async signTypedData(chainId: number, typedData: unknown): Promise<string> {
    this.assertChain(chainId);
    return this.account.signTypedData(typedData as TypedDataDefinition);
  }
}
