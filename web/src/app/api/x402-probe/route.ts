import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Server-side proxy that pokes the live verdict endpoint with NO payment attached. The worker answers
// HTTP 402 with an x402 `accepts` challenge (network / amount / payTo). We surface just those fields so
// the /developers page can show a real paid rail without exposing the browser to a cross-origin call.
const WORKER = process.env.WORKER_URL ?? 'https://verdikt-worker.fly.dev';

// A non-existent workId: enough to trigger the 402 payment challenge, never a real settlement.
const PROBE_BODY = {
  workId: '0x0000000000000000000000000000000000000000000000000000000000000001',
  artifact: { type: 'tool_output', payload: '{}' },
};

interface Accept { network?: string; amount?: string; payTo?: string }

export async function GET() {
  try {
    const res = await fetch(`${WORKER}/api/verdict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(PROBE_BODY),
      cache: 'no-store',
    });

    const body = (await res.json().catch(() => ({}))) as {
      accepts?: Accept[];
      fee_usdc?: string | number;
    };
    const accept = body.accepts?.[0] ?? {};

    return NextResponse.json({
      status: res.status,
      network: accept.network ?? null,
      amount: accept.amount ?? null,
      feeUsdc: body.fee_usdc ?? null,
      payTo: accept.payTo ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
