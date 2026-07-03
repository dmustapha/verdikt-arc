import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic'; // always the live list, never a cached one

// Proxy GET /api/jobs?payer=0x… — the returnable job LIST for the connected buyer (WS8 dashboard).
// The worker owns the truth (joins vk_jobs to vk_tasks.payer); this just forwards the payer query.
export async function GET(req: NextRequest) {
  const payer = req.nextUrl.searchParams.get('payer') ?? '';
  try {
    const res = await fetch(`${process.env.WORKER_URL}/api/jobs?payer=${encodeURIComponent(payer)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: `worker unreachable: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
}

// Proxy POST /api/jobs — dispatch the funded escrow to the chosen catalog seller. The worker gates
// this route with X-Demo-Secret (control-plane auth); the browser must NEVER see it, so this
// server-side route injects DEMO_SHARED_SECRET. The human's authority is already established: they
// signed the EIP-3009 funding and the escrow is FUNDED on-chain (the worker re-checks that) before
// any dispatch. Returns 202 { jobId, state, callbackToken, callbackUrls, deadline }.
export async function POST(req: NextRequest) {
  let body: unknown = {};
  try { body = await req.json(); } catch { /* worker 400s on empty */ }
  const secret = process.env.DEMO_SHARED_SECRET;
  if (!secret) return NextResponse.json({ error: 'dispatch unavailable: server not configured' }, { status: 503 });
  try {
    const res = await fetch(`${process.env.WORKER_URL}/api/jobs`, {
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
