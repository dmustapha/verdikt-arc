import { Router } from 'express';
import { sseBus } from '../lib/sse-bus.js';

export const streamRouter = Router();

streamRouter.get('/api/stream/:workId', (req, res) => {
  const workId = req.params.workId as `0x${string}`;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');

  const unsubscribe = sseBus.subscribe(workId, (ev) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  });
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);

  req.on('close', () => { clearInterval(keepAlive); unsubscribe(); res.end(); });
});
