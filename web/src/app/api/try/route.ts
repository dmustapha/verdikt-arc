import { NextRequest, NextResponse } from 'next/server';

// Server-side proxy for the PUBLIC "Try it" rail. Unlike /api/demo this carries NO shared secret —
// /api/try is intentionally public (scope-gated + rate-limited worker-side). The client owns the
// workId and opens its SSE BEFORE this POST, so we only await the worker's 202 ACK, not the ~25s run.
// The caller's IP is forwarded so the worker rate-limits per real client, not per Vercel egress IP.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body → worker 400s */ }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  try {
    const res = await fetch(`${process.env.WORKER_URL}/api/try`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(fwd ? { 'x-forwarded-for': fwd } : {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? 'worker timed out' : `worker unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return NextResponse.json({ error: msg }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
