import { NextRequest, NextResponse } from 'next/server';

// Proxy POST /faucet — drip test USDC to the connected wallet so it can escrow. Forwards the caller IP
// for the worker's per-client rate limit; waits for the drip receipt (a few seconds).
export async function POST(req: NextRequest) {
  let body: unknown = {};
  try { body = await req.json(); } catch { /* worker 400s on empty */ }
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 70_000);
  try {
    const res = await fetch(`${process.env.WORKER_URL}/faucet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(fwd ? { 'x-forwarded-for': fwd } : {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? 'faucet timed out' : `faucet unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return NextResponse.json({ error: msg }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
