import { NextResponse } from 'next/server';

// Proxy the worker's curated catalog. The human catalog only shows sellers that carry a pre-built
// acceptance template (so the human knows exactly what to supply) — template-less entries (e.g. the
// raw a2a seller) are hidden from the buyer surface but remain registered.
export async function GET() {
  try {
    const res = await fetch(`${process.env.WORKER_URL}/sellers`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({ sellers: [] }));
    const sellers = Array.isArray(data.sellers) ? data.sellers.filter((s: { acceptanceTemplate?: unknown }) => s.acceptanceTemplate) : [];
    return NextResponse.json({ sellers }, { status: res.ok ? 200 : res.status });
  } catch (err) {
    return NextResponse.json({ error: `catalog unreachable: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
}
