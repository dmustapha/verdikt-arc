// SSRF guard for OUTBOUND fetches to seller-controlled URLs (dispatch, poll, and the authoritative
// A2A re-fetch after a push callback). A malicious or compromised seller could register an internal
// URL (cloud metadata, a DB, another service on the private network) and trick the worker into
// fetching it. This gate enforces: HTTPS only, no private/loopback/link-local IP literals, and — when
// an allowlist is supplied — the URL's origin must be a registered seller origin.
//
// Scope boundary: this blocks IP-LITERAL hosts. A DNS name that resolves to a private IP (DNS
// rebinding) is NOT caught here — the registered-origin allowlist is the real defense against that, so
// production callers ALWAYS pass allowedOrigins. Kept honest rather than pretending to be a full
// network-layer egress filter.

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

function isPrivateIPv4(host: string): boolean {
  const o = ipv4Octets(host);
  if (!o) return false;
  const [a, b] = o;
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 127) return true;                         // loopback
  if (a === 0) return true;                           // 0.0.0.0/8 "this host"
  if (a === 169 && b === 254) return true;            // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
  return false;
}

function isPrivateIPv6(host: string): boolean {
  // URL hostname strips the [...] brackets. Normalize and check loopback / ULA / link-local.
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true;         // loopback / unspecified
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
  if (h.startsWith('fe80')) return true;             // link-local
  return false;
}

function isPrivateHost(hostname: string): boolean {
  // WHATWG URL keeps IPv6 hosts bracketed ("[::1]") — strip for the IPv6 check.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isPrivateIPv4(h)) return true;
  if (h.includes(':') && isPrivateIPv6(h)) return true;
  return false;
}

export interface SafeUrlOpts {
  allowedOrigins?: string[]; // if set, the URL's origin MUST be one of these (registered seller origins)
  allowPrivate?: boolean;    // escape hatch for LIVE local-mock-seller proof scripts only — never in prod
}

export function assertSafeUrl(raw: string, opts: SafeUrlOpts = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`unsafe callback URL: malformed (${raw})`);
  }

  if (opts.allowPrivate) {
    // Local escape hatch: still require http(s), but skip the private-range block.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsafe callback URL: scheme must be http(s)');
    return url;
  }

  if (url.protocol !== 'https:') {
    throw new Error(`unsafe callback URL: must be https (${url.protocol})`);
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error(`unsafe callback URL: private/loopback host not allowed (${url.hostname})`);
  }
  if (opts.allowedOrigins && opts.allowedOrigins.length > 0 && !opts.allowedOrigins.includes(url.origin)) {
    throw new Error(`unsafe callback URL: origin ${url.origin} not in the registered seller allowlist`);
  }
  return url;
}
