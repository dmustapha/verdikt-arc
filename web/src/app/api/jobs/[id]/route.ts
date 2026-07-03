import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic'; // always the live job state, never cached

// Proxy GET /api/jobs/:id — the enriched, returnable DETAIL view (WS8 dashboard). The worker computes
// the DB state + independent on-chain escrow cross-check + verdict + proof tx hashes; this forwards it
// so the browser never needs the escrow ABI. The jobId (a random UUID) is the per-job capability token.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const res = await fetch(`${process.env.WORKER_URL}/api/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: `worker unreachable: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
}
