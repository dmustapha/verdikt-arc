import { NextRequest, NextResponse } from 'next/server';

// Proxy POST /relayer/fund (public — the human's pre-signed EIP-3009 authorization; the worker's
// RELAYER_KEY submits it so the human pays no gas). Forwards the caller IP for per-client rate limits.
// Funding can take a few seconds (waits for the Arc receipt), so allow a longer timeout than /api/tasks.
export async function POST(req: NextRequest) {
  let body: unknown = {};
  try { body = await req.json(); } catch { /* worker 400s on empty */ }
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 70_000);
  try {
    const res = await fetch(`${process.env.WORKER_URL}/relayer/fund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(fwd ? { 'x-forwarded-for': fwd } : {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? 'relayer timed out' : `relayer unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return NextResponse.json({ error: msg }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
