import Link from 'next/link';

type Route = 'courtroom' | 'proof' | 'ledger';

const LINKS: { href: string; label: string; key: Route }[] = [
  { href: '/courtroom', label: 'Courtroom', key: 'courtroom' },
  { href: '/proof', label: 'Proof', key: 'proof' },
  { href: '/ledger', label: 'Ledger', key: 'ledger' },
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
