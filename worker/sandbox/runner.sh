#!/bin/sh
# Runs all evidence tools over /work (mounted read-only) and prints combined JSON.
# Each tool failure is non-fatal — a missing section becomes null, the worker abstains.
# Semgrep reads rules baked into /rules at build time (the container runs with --network=none,
# so the registry is unreachable at run time — local configs keep the static evidence offline).
set +e
cd /work

# Static scanners target ONLY the worker's solution.py (the untrusted artifact under judgment).
# DEV-004: scanning all of /work would also flag the PAYER's payer_test.py (its asserts trip
# Bandit B101), polluting good artifacts with static findings and false-refunding good work.
# pytest still runs the full /work so the payer's test imports solution.py.
# --metrics=off + --disable-version-check stop semgrep's telemetry/version network calls, which
# otherwise hang ~90s retrying under --network=none. Offline + baked rules → ~4s (DEV-003).
semgrep --metrics=off --disable-version-check --config /rules/security-audit.yml --config /rules/sql-injection.yml --json --quiet /work/solution.py > /tmp/semgrep.json 2>/dev/null
bandit /work/solution.py -f json -o /tmp/bandit.json -q 2>/dev/null
python3 -m pytest /work --json-report --json-report-file=/tmp/pytest.json -q >/dev/null 2>&1

python3 - <<'PY'
import json
def load(p):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return None
print(json.dumps({
    "semgrep": load("/tmp/semgrep.json"),
    "bandit":  load("/tmp/bandit.json"),
    "pytest":  load("/tmp/pytest.json"),
}))
PY
