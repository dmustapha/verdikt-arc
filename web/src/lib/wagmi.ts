import { http, createConfig } from 'wagmi';
import { injected, coinbaseWallet } from 'wagmi/connectors';
import { arcTestnet } from './chains';

// wagmi config for the human buyer path. injected() discovers MetaMask (and any EIP-6963 wallet);
// coinbaseWallet() adds Coinbase Wallet. Arc testnet is the only chain — the flow guards the network
// and offers a one-click switch/add. ssr:true keeps hydration stable in the Next App Router.
export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected(), coinbaseWallet({ appName: 'Verdikt' })],
  transports: {
    [arcTestnet.id]: http(process.env.NEXT_PUBLIC_ARC_RPC_URL ?? 'https://rpc.testnet.arc.network'),
  },
  ssr: true,
});

declare module 'wagmi' {
  interface Register { config: typeof wagmiConfig }
}
