// Vitest global setup: load repo-root .env so DB-backed integration tests have
// POSTGRES_URL. No-op when env is already present (CI / `source .env` callers).
// Pure unit tests don't read these vars, so this is harmless for them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

if (!process.env.POSTGRES_URL) {
  try {
    const envPath = join(process.cwd(), '..', '.env');
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      if (process.env[key]) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch {
    // .env absent (e.g. CI with injected env) — rely on the real environment.
  }
}
