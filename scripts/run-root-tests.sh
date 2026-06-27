#!/usr/bin/env bash
# Runs the root-level integration/unit tests (tests/**/*.test.ts) with Node's
# built-in node:test runner via tsx. These tests live at the repo root (outside
# worker/) because they assert cross-cutting contracts: the migrated vk_ Postgres
# schema (integration/schema.test.ts) and the on-chain uint8 code maps
# (unit/types.test.ts). They were previously orphaned — not wired to any npm
# script. This makes them a first-class `npm test`.
#
# Env is loaded from .env (POSTGRES_URL etc.). NODE_PATH points at worker's
# node_modules so the root-located tests resolve @vercel/postgres without a
# duplicate install.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a; source .env; set +a
fi

export NODE_PATH="$ROOT/worker/node_modules"
TSX="$ROOT/worker/node_modules/.bin/tsx"

if [[ ! -x "$TSX" ]]; then
  echo "error: tsx not found at $TSX — run 'npm install' in worker/ first" >&2
  exit 1
fi

# node:test glob; tsx transpiles the .ts on the fly.
exec "$TSX" --test tests/unit/*.test.ts tests/integration/*.test.ts
