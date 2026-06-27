import { defineChain } from 'viem';

export const ARC_CHAIN_ID = 5042002;
export const ARC_USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const;
export const ARC_EXPLORER = 'https://testnet.arcscan.app';

export const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: 'Arc Testnet',
  // Native gas is paid in USDC; ERC-20 interface is 6 decimals. The chain's
  // native unit is 18 decimals internally — never divide raw gas by 1e18 to get USDC.
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'Arcscan', url: ARC_EXPLORER } },
  testnet: true,
});
