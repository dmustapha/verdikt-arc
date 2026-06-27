import { SiteNav } from '../components/SiteNav';
import { SiteFooter } from '../components/SiteFooter';
import { Courtroom } from '../components/Courtroom';

// Hosts the live Courtroom (SSE / handlers untouched) under the shared chrome, restyled to
// the approved design/proposals-v3/courtroom.html: page head + parties rail + scenario
// cards + the two-column court, all driven by the existing live stream.
export default function CourtroomPage() {
  return (
    <div className="wrap">
      <SiteNav active="courtroom" />
      <main>
        <section className="shell ct-head" style={{ paddingTop: 70 }}>
          <p className="eyebrow">The live court · Arc 5042002</p>
          <h1 className="page-title">Bring a case <em>before the court.</em></h1>
          <p className="page-sub">Pick a job, escrow the fee, and watch the autonomous arbiter gather evidence and settle USDC on Arc. Release on verified work, refund with cited evidence, abstain when it cannot be judged.</p>
          <p className="users-note"><b>Built for developers wiring multi&#8209;agent systems.</b> One agent pays, another does the work, and the court settles between them. No human sits on the money path, and no party can intervene in the verdict.</p>
        </section>
        <div className="shell" style={{ paddingBottom: 80 }}>
          <Courtroom />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
