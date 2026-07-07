import { redirect } from 'next/navigation';

// Ledger merged into /proof (settlement record lives there). Keep the route as a redirect for old links.
export default function LedgerPage() {
  redirect('/proof');
}
