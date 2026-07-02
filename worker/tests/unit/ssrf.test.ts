import { describe, it, expect } from 'vitest';
import { assertSafeUrl } from '../../src/lib/ssrf.js';

describe('ssrf — protocol', () => {
  it('accepts an https public URL', () => {
    expect(assertSafeUrl('https://seller.example.com/a2a/result/1').origin).toBe('https://seller.example.com');
  });
  it('rejects http (non-TLS)', () => {
    expect(() => assertSafeUrl('http://seller.example.com/x')).toThrow(/https/i);
  });
  it('rejects a non-http(s) scheme', () => {
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow();
    expect(() => assertSafeUrl('gopher://x')).toThrow();
  });
  it('rejects a malformed URL', () => {
    expect(() => assertSafeUrl('not a url')).toThrow();
  });
});

describe('ssrf — private / loopback / metadata targets', () => {
  const blocked = [
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://192.168.0.1/x',
    'https://172.16.5.4/x',
    'https://169.254.169.254/latest/meta-data', // cloud metadata SSRF classic
    'https://[::1]/x',
    'https://0.0.0.0/x',
  ];
  it.each(blocked)('blocks %s', (url) => {
    expect(() => assertSafeUrl(url)).toThrow(/private|loopback|not allowed|blocked/i);
  });
});

describe('ssrf — registered-origin allowlist', () => {
  it('rejects a public URL whose origin is not in the allowlist', () => {
    expect(() => assertSafeUrl('https://evil.example.com/x', { allowedOrigins: ['https://seller.example.com'] }))
      .toThrow(/allow/i);
  });
  it('accepts a public URL whose origin IS in the allowlist', () => {
    expect(assertSafeUrl('https://seller.example.com/deep/path', { allowedOrigins: ['https://seller.example.com'] }).host)
      .toBe('seller.example.com');
  });
});

describe('ssrf — explicit local escape hatch (live scripts only)', () => {
  it('allows loopback when allowPrivate is set', () => {
    expect(assertSafeUrl('http://127.0.0.1:8790/deliver', { allowPrivate: true }).port).toBe('8790');
  });
});
