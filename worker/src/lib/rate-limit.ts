import type { Request } from 'express';

// Reusable in-memory rate limiter: per-IP sliding window + optional global daily cap. In-memory means
// it resets on worker restart, which is fine for abuse control on a testnet service (the goal is to
// stop a script from spamming, not to be a billing-grade quota).
export interface RateLimitConfig { perIp: number; ipWindowMs: number; globalPerDay?: number; }

export function createRateLimiter(cfg: RateLimitConfig): (ip: string, now: number) => string | null {
  const ipHits = new Map<string, number[]>();
  let dayStart = 0;
  let dayCount = 0;
  return (ip: string, now: number): string | null => {
    if (cfg.globalPerDay !== undefined) {
      if (now - dayStart > 24 * 60 * 60 * 1000) { dayStart = now; dayCount = 0; }
      if (dayCount >= cfg.globalPerDay) return 'daily limit reached — try again later or run it locally';
    }
    const recent = (ipHits.get(ip) ?? []).filter((t) => now - t < cfg.ipWindowMs);
    if (recent.length >= cfg.perIp) return `rate limit: ${cfg.perIp} per ${Math.round(cfg.ipWindowMs / 60000)} min`;
    recent.push(now);
    ipHits.set(ip, recent);
    if (cfg.globalPerDay !== undefined) dayCount++;
    return null;
  };
}

// The real client IP behind Fly's proxy (X-Forwarded-For first hop; req.ip needs `trust proxy`).
export function clientIp(req: Request): string {
  const fwd = req.header('x-forwarded-for');
  return (fwd ? fwd.split(',')[0].trim() : req.ip) || 'unknown';
}
