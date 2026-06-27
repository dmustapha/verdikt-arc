import { fundEscrow } from '../../worker/src/settlement/fund-escrow.js';

export { fundEscrow };

// CLI: fund a fresh escrow as the demo payer agent.
// Usage: ESCROW_ADDRESS=… ARC_RPC_URL=… DEMO_PAYER_KEY=… tsx scripts/agents/payer.ts <workId> <worker> <amountUsdc>
if (process.argv[2]) {
  const [workId, worker, amount] = process.argv.slice(2);
  fundEscrow({
    payerKey: process.env.DEMO_PAYER_KEY as `0x${string}`,
    workId: workId as `0x${string}`,
    worker: worker as `0x${string}`,
    amountUsdc: parseFloat(amount ?? '1'),
  }).then((tx) => console.log('[payer] funded:', tx));
}
