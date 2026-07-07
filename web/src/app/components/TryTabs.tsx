'use client';
import { useState } from 'react';
import { Courtroom } from './Courtroom';
import { TryIt } from './TryIt';

// Merged /try: two doors to the SAME verdict engine. "Presets" runs the canned scenarios (the old
// courtroom); "Bring your own" takes a stranger's task. Both components are reused verbatim (their SSE
// / settlement logic is untouched); this only switches which one is mounted. In watch mode (?workId=)
// we default to Presets and hand the workId to the Courtroom to replay that agent run.
export function TryTabs({ watchWorkId }: { watchWorkId?: string }) {
  const [tab, setTab] = useState<'presets' | 'byo'>(watchWorkId ? 'presets' : 'byo');
  return (
    <div>
      {!watchWorkId && (
        <div className="try-tabs" role="tablist" aria-label="Try Verdikt">
          <button role="tab" aria-selected={tab === 'byo'} className={`try-tab${tab === 'byo' ? ' active' : ''}`} onClick={() => setTab('byo')}>
            Bring your own task
          </button>
          <button role="tab" aria-selected={tab === 'presets'} className={`try-tab${tab === 'presets' ? ' active' : ''}`} onClick={() => setTab('presets')}>
            Run a preset
          </button>
        </div>
      )}
      {tab === 'byo' && !watchWorkId ? <TryIt /> : <Courtroom watchWorkId={watchWorkId} />}
    </div>
  );
}
