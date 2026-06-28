import { NextRequest, NextResponse } from 'next/server';

// Server-side proxy carrying the shared secret (which must never reach the browser). The CLIENT now
// owns the workId and opens its SSE stream BEFORE this POST, so the worker only needs to ACK 202 and
// run async — this proxy waits for the ACK, not the whole ~25s run. M-2 (worker/payer/amount) is
// enforced worker-side from env; we forward only the client's workId.
export async function POST(req: NextRequest, ctx: { params: Promise<{ type: string }> }) {
  const { type } = await ctx.params;
  let workId: string | undefined;
  try { workId = (await req.json())?.workId; } catch { /* no body */ }
  if (!workId) return NextResponse.json({ error: 'workId required' }, { status: 400 });

  // Only the 202 ACK is awaited now, so a short cap suffices; a hung/unreachable worker fails fast
  // with a visible 502 instead of spinning on camera.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${process.env.WORKER_URL}/api/demo/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-Secret': process.env.DEMO_SHARED_SECRET ?? '' },
      body: JSON.stringify({ workId }),
      signal: ctrl.signal,
    });
    const data = await res.json();
    return NextResponse.json({ workId, ...data }, { status: res.ok ? res.status : res.status });
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? 'worker timed out' : `worker unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return NextResponse.json({ error: msg }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
