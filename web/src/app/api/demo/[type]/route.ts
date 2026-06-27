import { NextRequest, NextResponse } from 'next/server';

// Generate a 32-byte (bytes32) workId.
function randomWorkId(): `0x${string}` {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

// Server-side proxy. The worker funds a fresh escrow on-chain (real EIP-3009) and then
// runs the verdict, so each click is a real, independent fund→verdict→settle on Arc.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ type: string }> }) {
  const { type } = await ctx.params;
  const workId = randomWorkId();

  // Bound the upstream call so an unreachable/hung worker fails fast with a visible
  // 502 instead of leaving the courtroom spinning on "starting…" forever on camera.
  // The real fund→verdict→settle path (Docker sandbox + static scan + LLM + two on-chain
  // txs) runs ~25-30s for the code routes, so the cap must clear it with margin — 15s was
  // shorter than the hero path and aborted every real run. 90s = worst case + headroom.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(`${process.env.WORKER_URL}/api/demo/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-Secret': process.env.DEMO_SHARED_SECRET ?? '' },
      body: JSON.stringify({
        workId,
        payer: process.env.DEMO_PAYER_ADDRESS,
        worker: process.env.DEMO_WORKER_ADDRESS,
        amountUsdc: 1,
      }),
      signal: ctrl.signal,
    });
    const data = await res.json();
    return NextResponse.json({ workId, ...data }, { status: res.ok ? 200 : res.status });
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? 'worker timed out' : `worker unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return NextResponse.json({ error: msg }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
