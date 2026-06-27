import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { payVerdict } from '../gateway-buyer.js';

// Usage: WORKER tsx scripts/agents/worker-abstain.ts <workId>
export async function deliverAbstain(workId: `0x${string}`): Promise<void> {
  const payload = await readFile(join(process.cwd(), 'fixtures/task-answer/unsupported_answer.txt'), 'utf8');
  const result = await payVerdict(`${process.env.WORKER_URL}/api/verdict`, {
    workId, artifact: { type: 'answer', payload },
  });
  console.log('[worker-abstain] verdict:', result);
}

if (process.argv[2]) deliverAbstain(process.argv[2] as `0x${string}`).catch((e) => { console.error(e); process.exit(1); });
