import { SiteNav } from '../../components/SiteNav';
import { SiteFooter } from '../../components/SiteFooter';
import { JobDetail } from '../../components/JobDetail';

// Per-job detail (WS8). The jobId (an unguessable UUID) is the capability token — anyone with the link
// HireFlow handed the buyer can track this one job. The detail + live SSE are client-driven.
export const metadata = { title: 'Job — Verdikt' };
export const dynamic = 'force-dynamic';

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const escrow = (process.env.NEXT_PUBLIC_ESCROW_ADDRESS ?? process.env.ESCROW_ADDRESS ?? '') as `0x${string}`;
  return (
    <div className="wrap">
      <SiteNav active="jobs" />
      <main>
        <section className="shell" style={{ paddingTop: 56, paddingBottom: 80 }}>
          <JobDetail jobId={jobId} escrow={escrow} />
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
