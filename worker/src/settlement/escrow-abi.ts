// Minimal ABI for VerdiktEscrow — settlement writes (via Circle DCW) + reads (via viem).
export const VERDIKT_ESCROW_ABI = [
  {
    type: 'function',
    name: 'fundWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'workId', type: 'bytes32' },
      { name: 'worker', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'sig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'workId', type: 'bytes32' },
      { name: 'verdictCode', type: 'uint8' },
      { name: 'evidenceHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getEscrow',
    stateMutability: 'view',
    inputs: [{ name: 'workId', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'payer', type: 'address' },
          { name: 'worker', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'status', type: 'uint8' },
          { name: 'outcome', type: 'uint8' },
          { name: 'verdictCode', type: 'uint8' },
          { name: 'evidenceHash', type: 'bytes32' },
        ],
      },
    ],
  },
  {
    type: 'event',
    name: 'Funded',
    inputs: [
      { name: 'workId', type: 'bytes32', indexed: true },
      { name: 'payer', type: 'address', indexed: false },
      { name: 'worker', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Settled',
    inputs: [
      { name: 'workId', type: 'bytes32', indexed: true },
      { name: 'outcome', type: 'uint8', indexed: false },
      { name: 'to', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'verdictCode', type: 'uint8', indexed: false },
      { name: 'evidenceHash', type: 'bytes32', indexed: false },
    ],
  },
] as const;

// The `settle` signature string Circle DCW contractExecution expects. The outcome is derived
// on-chain from verdictCode (M-3), so it is no longer a parameter.
export const SETTLE_FN_SIGNATURE = 'settle(bytes32,uint8,bytes32)';
