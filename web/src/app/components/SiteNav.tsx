import Link from 'next/link';

type Route = 'courtroom' | 'try' | 'hire' | 'developers' | 'jobs' | 'proof' | 'ledger';

const LINKS: { href: string; label: string; key: Route }[] = [
  { href: '/try', label: 'Try it', key: 'try' },
  { href: '/hire', label: 'Hire an agent', key: 'hire' },
  { href: '/developers', label: 'Developers', key: 'developers' },
  { href: '/jobs', label: 'Your jobs', key: 'jobs' },
  { href: '/proof', label: 'Proof', key: 'proof' },
];

// Shared topbar: Verdikt wordmark + emerald dot, primary nav, Arc-testnet live pill.
export function SiteNav({ active }: { active?: Route }) {
  return (
    <header className="shell topbar">
      <Link className="wordmark" href="/" aria-label="Verdikt home">
        <span className="dot" />Verdikt
      </Link>
      <nav className="topnav" aria-label="Primary">
        {LINKS.map(({ href, label, key }) => (
          <Link
            key={key}
            className={`hide-sm${active === key ? ' active' : ''}`}
            href={href}
            aria-current={active === key ? 'page' : undefined}
          >
            {label}
          </Link>
        ))}
        <span className="pill"><span className="live" />Arc testnet</span>
      </nav>
    </header>
  );
}
