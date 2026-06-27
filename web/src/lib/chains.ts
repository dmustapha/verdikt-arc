import { defineChain } from 'viem';

export const ARC_EXPLORER = 'https://testnet.arcscan.app';
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_ARC_RPC_URL ?? 'https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'Arcscan', url: ARC_EXPLORER } },
  testnet: true,
});
export const txUrl = (hash: string) => `${ARC_EXPLORER}/tx/${hash}`;
export const addressUrl = (addr: string) => `${ARC_EXPLORER}/address/${addr}`;
