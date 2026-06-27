import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ workId: string }> }) {
  const { workId } = await ctx.params;
  const upstream = await fetch(`${process.env.WORKER_URL}/api/stream/${workId}`, { headers: { Accept: 'text/event-stream' } });
  return new Response(upstream.body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' },
  });
}
