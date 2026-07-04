import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Proxy POST /api/jobs/:id/dispute — a party contests a PROPOSED verdict during its challenge window
// (WS11). The worker escalates to the MOCKED arbiter, which rules and settles on-chain, landing the job
// RESOLVED. The worker gates this with X-Demo-Secret (control-plane auth), so — exactly like the
// dispatch proxy — this server route injects DEMO_SHARED_SECRET and the browser never sees it. The
// human's authority is the per-job UUID capability token (only the job's owner has the link). The
// response carries `arbiterMock: true` (honest boundary — a demo stand-in, not real arbitration).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown = {};
  try { body = await req.json(); } catch { /* worker 400s on a bad body */ }
  const secret = process.env.DEMO_SHARED_SECRET;
  if (!secret) return NextResponse.json({ error: 'dispute unavailable: server not configured' }, { status: 503 });
  try {
    const res = await fetch(`${process.env.WORKER_URL}/api/jobs/${encodeURIComponent(id)}/dispute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-Secret': secret },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: `worker unreachable: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
}
