'use client';

import { useEffect, useRef } from 'react';

interface VerdictBannerProps {
  verdict: 'pass' | 'fail' | 'partial' | 'abstain' | null;
  outcome?: 'release' | 'refund' | 'abstain';
}

// All colors reference design tokens (globals.css owns the palette). Pure-glow per outcome.
function config(verdict: string, outcome?: string) {
  const escrowText =
    outcome === 'release' ? 'USDC released to worker'
    : outcome === 'abstain' ? 'USDC refunded to payer (abstain, no false-certify)'
    : 'USDC refunded to payer';
  const map: Record<string, { bg: string; color: string; border: string; glow: string }> = {
    pass: { bg: 'var(--brand-faint)', color: 'var(--release)', border: 'var(--brand-glow)', glow: 'var(--glow-brand)' },
    partial: { bg: 'var(--abstain-faint)', color: 'var(--abstain)', border: 'var(--abstain-line)', glow: 'var(--glow-abstain)' },
    fail: { bg: 'var(--refund-faint)', color: 'var(--refund)', border: 'var(--refund-line)', glow: 'var(--glow-refund)' },
    abstain: { bg: 'var(--abstain-faint)', color: 'var(--abstain)', border: 'var(--abstain-line)', glow: 'var(--glow-abstain)' },
  };
  const cfg = map[verdict] ?? map.abstain;
  return { ...cfg, label: verdict.toUpperCase(), detail: escrowText };
}

export function VerdictBanner({ verdict, outcome }: VerdictBannerProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!verdict || !ref.current) return;
    // f-settle: the verdict arrives with weight (rare, high-drama moment). GPU-composited.
    ref.current.animate?.(
      [{ transform: 'scale(0.9)', opacity: 0 }, { transform: 'scale(1.015)', opacity: 1 }, { transform: 'scale(1)', opacity: 1 }],
      { duration: 420, easing: 'cubic-bezier(0.16,1,0.3,1)', fill: 'forwards' },
    );
  }, [verdict]);
  if (!verdict) return null;
  const cfg = config(verdict, outcome);
  return (
    <div
      ref={ref}
      style={{
        borderRadius: 'var(--radius-lg)',
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        boxShadow: cfg.glow,
        padding: '22px 24px',
        textAlign: 'center',
      }}
    >
      <div className="vk-serif" style={{ fontSize: 'var(--fs-verdict)', lineHeight: 1, color: cfg.color, letterSpacing: '-0.01em' }}>
        {cfg.label}
      </div>
      <div className="mono" style={{ marginTop: 10, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {cfg.detail}
      </div>
    </div>
  );
}
