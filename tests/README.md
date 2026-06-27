# Tests

Three suites. Node's built-in `node:test` via `tsx` — no extra test deps.

```
tests/
  unit/          # pure-logic tests (no I/O)
  integration/   # live Postgres / cross-module
  contracts/     # Foundry forge tests (Phase 1+)
```

## Run

Unit (no env needed):
```bash
cd scripts && npx tsx --test ../tests/unit/*.test.ts
```

Integration (needs `.env` loaded + scripts deps on the module path):
```bash
cd scripts
set -a; source ../.env; set +a
NODE_PATH="$PWD/node_modules" npx tsx --test ../tests/integration/*.test.ts
```

The `NODE_PATH` export lets the test files (which live outside any package) resolve
`@vercel/postgres` from `scripts/node_modules`.

Contract tests:
```bash
cd contracts && forge test
```
