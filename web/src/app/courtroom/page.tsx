import { redirect } from 'next/navigation';

// Courtroom merged into /try (Run a preset tab). Preserve ?workId= watch links.
export default async function CourtroomPage({ searchParams }: { searchParams: Promise<{ workId?: string }> }) {
  const { workId } = await searchParams;
  redirect(workId ? `/try?workId=${encodeURIComponent(workId)}` : '/try');
}
