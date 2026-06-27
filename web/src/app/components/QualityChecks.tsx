'use client';

import type { EvidenceItem } from '../../types';

// Maps a live evidence status to the courtroom gate-pill class (globals.css owns the palette).
const PILL_CLASS: Record<string, string> = { pass: 'pass', fail: 'fail', error: 'fail', info: 'none' };

// The evidence panel of the court — renders each gathered check as a gate row with a
// pass/fail pill, matching the approved courtroom mockup. Data contract unchanged: { items }.
export function QualityChecks({ items }: { items: EvidenceItem[] }) {
  const passCount = items.filter((i) => i.status === 'pass').length;
  return (
    <div className="evidence" aria-label="Evidence">
      <div className="ev-head">
        <span className="ev-title">Evidence</span>
        <span className="ev-tally">{passCount} / {items.length} pass</span>
      </div>
      <div>
        {items.map((item) => (
          <div key={item.id} className="gate-row">
            <span className="g-name">{item.label}{item.detail ? ` · ${item.detail}` : ''}{item.ref ? ` · ${item.ref}` : ''}</span>
            <span className={`gate-pill ${PILL_CLASS[item.status] ?? 'none'}`}>{item.status.toUpperCase()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
