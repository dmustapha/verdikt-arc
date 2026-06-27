import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { payVerdict } from '../gateway-buyer.js';

// Usage: WORKER tsx scripts/agents/worker-bad.ts <workId>
export async function deliverBad(workId: `0x${string}`): Promise<void> {
  const payload = await readFile(join(process.cwd(), 'fixtures/task-code/bad_solution.py'), 'utf8');
  const result = await payVerdict(`${process.env.WORKER_URL}/api/verdict`, {
    workId, artifact: { type: 'code', language: 'python', payload },
  });
  console.log('[worker-bad] verdict:', result);
}

if (process.argv[2]) deliverBad(process.argv[2] as `0x${string}`).catch((e) => { console.error(e); process.exit(1); });
