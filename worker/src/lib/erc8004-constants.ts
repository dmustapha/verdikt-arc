// Canonical ERC-8004 "Trustless Agents" deployments (draft standard, v2.0.0 UUPS).
// Reference contracts: github.com/erc-8004/erc-8004-contracts @ commit
// 68fc6765761a10fb26f0692df21c8a6f9d12b1be (MIT). The testnet set uses the same CREATE2
// vanity addresses on every testnet (Ethereum Sepolia, Base Sepolia, Amoy, …).
//
// Verdikt targets the LIVE canonical registries on Base Sepolia (chainId 84532): it READS
// agent identity and WRITES a validationResponse (the verdict) to the canonical Validation
// Registry. Every address is re-verified on-chain via getCode + getVersion before wiring
// (see scripts/verify-erc8004-onchain.ts) — never trust these constants blind.
export const BASE_SEPOLIA_CHAIN_ID = 84532;

// Testnet vanity address set (identical across all ERC-8004 testnets).
export const ERC8004_IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;
export const ERC8004_REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const;
export const ERC8004_VALIDATION_REGISTRY = '0x8004Cb1BF31DAf7788923b405b754f57acEB4272' as const;

export const BASE_SEPOLIA_EXPLORER = 'https://sepolia.basescan.org';
export const BASE_SEPOLIA_EXPLORER_TX = `${BASE_SEPOLIA_EXPLORER}/tx/`;
export const BASE_SEPOLIA_EXPLORER_ADDR = `${BASE_SEPOLIA_EXPLORER}/address/`;
