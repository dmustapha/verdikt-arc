// Minimal ABI for VerdiktEscrow (v5) — settlement writes (via Circle DCW) + reads (via viem).
const PAYOUT_ROUTES = {
  name: 'routes',
  type: 'tuple',
  components: [
    { name: 'workerDomain', type: 'uint32' },
    { name: 'workerRecipient', type: 'bytes32' },
    { name: 'payerDomain', type: 'uint32' },
    { name: 'payerRecipient', type: 'bytes32' },
  ],
} as const;

export const VERDIKT_ESCROW_ABI = [
  {
    type: 'function',
    name: 'fundWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'workId', type: 'bytes32' },
      { name: 'worker', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
      { name: 'ttl', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'sig', type: 'bytes' },
      PAYOUT_ROUTES,
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
    name: 'settlePartial',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'workId', type: 'bytes32' },
      { name: 'bps', type: 'uint16' },
      { name: 'evidenceHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'refundExpired',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'workId', type: 'bytes32' }],
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
          { name: 'fee', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'status', type: 'uint8' },
          { name: 'outcome', type: 'uint8' },
          { name: 'verdictCode', type: 'uint8' },
          { name: 'evidenceHash', type: 'bytes32' },
          { name: 'workerPayoutDomain', type: 'uint32' },
          { name: 'workerPayoutRecipient', type: 'bytes32' },
          { name: 'payerPayoutDomain', type: 'uint32' },
          { name: 'payerPayoutRecipient', type: 'bytes32' },
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
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'deadline', type: 'uint256', indexed: false },
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
  {
    type: 'event',
    name: 'SettledPartial',
    inputs: [
      { name: 'workId', type: 'bytes32', indexed: true },
      { name: 'workerTo', type: 'address', indexed: false },
      { name: 'workerAmount', type: 'uint256', indexed: false },
      { name: 'payerTo', type: 'address', indexed: false },
      { name: 'payerAmount', type: 'uint256', indexed: false },
      { name: 'bps', type: 'uint16', indexed: false },
      { name: 'evidenceHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Expired',
    inputs: [
      { name: 'workId', type: 'bytes32', indexed: true },
      { name: 'to', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'FeePaid',
    inputs: [
      { name: 'workId', type: 'bytes32', indexed: true },
      { name: 'to', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;

// Signature strings Circle DCW contractExecution expects. Outcomes are derived on-chain from
// the verdict (M-3): settle() handles pass/fail/abstain; settlePartial() does the real bps split.
export const SETTLE_FN_SIGNATURE = 'settle(bytes32,uint8,bytes32)';
export const SETTLE_PARTIAL_FN_SIGNATURE = 'settlePartial(bytes32,uint16,bytes32)';
export const REFUND_EXPIRED_FN_SIGNATURE = 'refundExpired(bytes32)';
