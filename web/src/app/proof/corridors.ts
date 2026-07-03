// WS9 — >=6-corridor CCTP V2 matrix (Gate F1). Self-contained: resolved explorer URLs are
// inlined (no SDK import). Captured live 2026-07-03 on the v6 escrow
// 0x96c47a608218E1aFea36E37f9619FB83E24CDF77 via agents/prove-corridor-matrix.ts. Each corridor
// is a full 4-leg round-trip; feeNetUsdc is the seller's dest-chain balance delta, asserted
// on-chain against the escrow's amount - fee (independent of any DB).

export type CorridorLeg = { label: string; chain: string; url: string };
export type Corridor = {
  id: string; source: string; dest: string; sourceDomain: number; destDomain: number;
  amountUsdc: number; feeNetUsdc: number; destDeltaRaw: string; legs: CorridorLeg[];
};

export const CORRIDORS: Corridor[] = [
  {
    "id": "ethereumSepolia->baseSepolia",
    "source": "Ethereum Sepolia",
    "dest": "Base Sepolia",
    "sourceDomain": 0,
    "destDomain": 6,
    "amountUsdc": 0.5,
    "feeNetUsdc": 0.49995,
    "destDeltaRaw": "499950",
    "legs": [
      {
        "label": "1 \u00b7 burn (source)",
        "chain": "Ethereum Sepolia",
        "url": "https://sepolia.etherscan.io/tx/0x828723bb7886368dde61dd30ee8c800f8c6fd8b506d1c8776b6dfaef6a699c3d"
      },
      {
        "label": "2 \u00b7 mint + fund escrow (Arc)",
        "chain": "Arc",
        "url": "https://testnet.arcscan.app/tx/0xbabd0110ba06b938fb8565dd7a73b46369603e2056595e334ad28d6853ad091e"
      },
      {
        "label": "3 \u00b7 settle + payout burn (Arc)",
        "chain": "Arc",
        "url": "https://testnet.arcscan.app/tx/0xdedd13dba0c185629d513f2c24d41775000b40d98409b1ffa89e81a6597b0527"
      },
      {
        "label": "4 \u00b7 paid, fee-net (dest)",
        "chain": "Base Sepolia",
        "url": "https://sepolia.basescan.org/tx/0x67e0d697ae737c12d6b84c5c887e194866ba6cab0db79d0b6e64966675a0df25"
      }
    ]
  },
  {
    "id": "baseSepolia->ethereumSepolia",
    "source": "Base Sepolia",
    "dest": "Ethereum Sepolia",
    "sourceDomain": 6,
    "destDomain": 0,
    "amountUsdc": 0.5,
    "feeNetUsdc": 0.499935,
    "destDeltaRaw": "499935",
    "legs": [
      {
        "label": "1 \u00b7 burn (source)",
        "chain": "Base Sepolia",
        "url": "https://sepolia.basescan.org/tx/0xad0ca6689584928a662afec499dd0d1c3619f68d4551b33068628d8e511a5c26"
      },
      {
        "label": "2 \u00b7 mint + fund escrow (Arc)",
        "chain": "Arc",
        "url": "https://testnet.arcscan.app/tx/0xa1114d16ad7705e92caabe3c93582f62a7add485c155e6cbf5a004563146f400"
      },
      {
        "label": "3 \u00b7 settle + payout burn (Arc)",
        "chain": "Arc",
        "url": "https://testnet.arcscan.app/tx/0x689b31a547ff67d2c9b37d973faaad3c996652e939d59f53b43888cdd2e64a15"
      },
      {
        "label": "4 \u00b7 paid, fee-net (dest)",
        "chain": "Ethereum Sepolia",
        "url": "https://sepolia.etherscan.io/tx/0x14fd78e4b85cf62224f7cb3a224cea937ae45239f8de9e6d4b2ac90857f44244"
      }
    ]
  },
  {
    "id": "arbitrumSepolia->opSepolia",
    "source": "Arbitrum Sepolia",
    "dest": "OP Sepolia",
    "sourceDomain": 3,
    "destDomain": 2,
    "amountUsdc": 0.5,
    "feeNetUsdc": 0.499935,
    "destDeltaRaw": "499935",
    "legs": [
      {
        "label": "1 \u00b7 burn (source)",
        "chain": "Arbitrum Sepolia",
        "url": "https://sepolia.arbiscan.io/tx/0x8510ecdb7f1c756320d7289bafe032ca0d40043ee57955c0be1a62610aa80f1b"
      },
      {
        "label": "2 \u00b7 mint + fund escrow (Arc)",
        "chain": "Arc",
        "url": "https://testnet.arcscan.app/tx/0x3c1213b449420c48ec97382926cd8b30a2f599865ecb88d8915607472a24fb6c"
      },
      {
        "label": "3 \u00b7 settle + payout burn (Arc)",
        "chain": "Arc",
        "url": "https://testnet.arcscan.app/tx/0x6e045430250f98fd0c480d759fc95c0e0b0d3d7e57da9e5d29f1292c2577168e"
      },
      {
        "label": "4 \u00b7 paid, fee-net (dest)",
        "chain": "OP Sepolia",
        "url": "https://sepolia-optimism.etherscan.io/tx/0x44c2e1f13d2735deb63e82e8b6ec8cd995811f9eabfd85502dc99734c294acd0"
      }
    ]
  },
  {
    "id": "opSepolia->arbitrumSepolia",
    "source": "OP Sepolia",
    "dest": "Arbitrum Sepolia",
    "sourceDomain": 2,
    "destDomain": 3,
    "amountUsdc": 0.5,
    "feeNetUsdc": 0.499935,
    "destDeltaRaw": "499935",
    "legs": [
      {
        "label": "1 \u00b7 burn (source)",
        "chain": "OP Sepolia",
        "url": "https://sepolia-optimism.etherscan.io/tx/0xccb2a8cb095648a09de58cb4a16714f4c30fd8b3f9c89560d9f09a70062a5c3d"
      },
      {
        "label": "2 \u00b7 mint + fund escrow (Arc)",
        "chain": "Arc",
        "url": "https://testnet.arcscan.app/tx/0x9fedcabc397c38f851874071044a4bdfaecf738b3f47d3932be51e203eba1b2c"
      },
      {
        "label": "3 \u00b7 settle + payout burn (Arc)",
        "chain": "Arc",
        "url": "https://testnet.arcscan.app/tx/0x83d090d853de57246c63f76884d3e964b5a408e10244e9214351f45047333df9"
      },
      {
        "label": "4 \u00b7 paid, fee-net (dest)",
        "chain": "Arbitrum Sepolia",
        "url": "https://sepolia.arbiscan.io/tx/0x00578a1fed061b715da23d7b18e8be568d1fb20214f81a754637f5bfc2994204"
      }
    ]
  },
  {
    "id": "polygonAmoy->baseSepolia",
    "source": "Polygon Amoy",
    "dest": "Base Sepolia",
    "sourceDomain": 7,
    "destDomain": 6,
    "amountUsdc": 0.5,
    "feeNetUsdc": 0.5,
    "destDeltaRaw": "500000",
    "legs": [
      {
        "label": "1 \u00b7 burn (source)",
        "chain": "Polygon Amoy",
        "url": "https://amoy.polygonscan.com/tx/0xe1db3784c9574666cea710107f3f0ab5a947cb29ec20c4b7a5a748f237d6adb1"
      },
      {
        "label": "2 \u00b7 mint + fund escrow (Arc)",
        "chain": "Arc",
        "url": "https://testnet.arcscan.app/tx/0x77ea72e2175fef4f247dd83469568e03b0d4d3a7d167af0eb22a93c559fc9892"
      },
      {
        "label": "3 \u00b7 settle + payout burn (Arc)",
        "chain": "Arc",
        "url": "https://testnet.arcscan.app/tx/0xc6398ae1961336c5dd5bd11ccf3d8a13935b0d4de538e61387d46efe2af003eb"
      },
      {
        "label": "4 \u00b7 paid, fee-net (dest)",
        "chain": "Base Sepolia",
        "url": "https://sepolia.basescan.org/tx/0x1e186a2e02b8c74470ef27813455a3c83a55225d1001600fcd1b75b83a528f85"
      }
    ]
  },
  {
    "id": "ethereumSepolia->polygonAmoy",
    "source": "Ethereum Sepolia",
    "dest": "Polygon Amoy",
    "sourceDomain": 0,
    "destDomain": 7,
    "amountUsdc": 0.5,
    "feeNetUsdc": 0.49995,
    "destDeltaRaw": "499950",
    "legs": [
      {
        "label": "1 \u00b7 burn (source)",
        "chain": "Ethereum Sepolia",
        "url": "https://sepolia.etherscan.io/tx/0x061c00698fec0c7001fa51cbf34cdc12c36c9e207ef7522027c8093315cbeac7"
      },
      {
        "label": "2 \u00b7 mint + fund escrow (Arc)",
        "chain": "Arc",
        "url": "https://testnet.arcscan.app/tx/0x60779a6ef77ba09843041f923425d9a220f7647dcc84a302f84852c9d5ed8453"
      },
      {
        "label": "3 \u00b7 settle + payout burn (Arc)",
        "chain": "Arc",
        "url": "https://testnet.arcscan.app/tx/0x3e6977dc035a2111fa928cd010c446bb37cf526ccbe171558386a4c5c2e4a80f"
      },
      {
        "label": "4 \u00b7 paid, fee-net (dest)",
        "chain": "Polygon Amoy",
        "url": "https://amoy.polygonscan.com/tx/0x7ddc625d60a74474e2e5ac754e32c7dd0911a3ada0819b760348c7956f401f5e"
      }
    ]
  }
];
