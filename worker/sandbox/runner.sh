#!/bin/sh
# Runs all evidence tools over /work (mounted read-only) and prints combined JSON.
# FAIL-CLOSED contract (H-B): each scanner reports an explicit {status:"ok"|"error"} derived from
# its exit code. A crashed / OOM-killed / unparseable scanner becomes status "error" — the worker
# then abstains (refund-to-payer), it NEVER yields zero findings that could let bad code release.
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
SEMGREP_RC=$?
bandit /work/solution.py -f json -o /tmp/bandit.json -q 2>/dev/null
BANDIT_RC=$?
python3 -m pytest /work --json-report --json-report-file=/tmp/pytest.json -q >/dev/null 2>&1

SEMGREP_RC=$SEMGREP_RC BANDIT_RC=$BANDIT_RC python3 - <<'PY'
import json, os
def load(p):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return None

semgrep_rc = int(os.environ.get("SEMGREP_RC", "1"))
bandit_rc  = int(os.environ.get("BANDIT_RC", "1"))
semgrep_doc = load("/tmp/semgrep.json")
bandit_doc  = load("/tmp/bandit.json")

# semgrep exits 0 even WITH findings (no --error flag) → ok ONLY on rc 0 AND parseable JSON.
# bandit exits 0 (no issues) or 1 (issues found) on success → ok on rc in {0,1} AND parseable.
# Anything else (internal crash, OOM kill = 137, unparseable output) → status "error".
semgrep_ok = semgrep_rc == 0 and semgrep_doc is not None
bandit_ok  = bandit_rc in (0, 1) and bandit_doc is not None

print(json.dumps({
    "semgrep": ({"status": "ok", "results": (semgrep_doc or {}).get("results", [])}
                if semgrep_ok else {"status": "error", "rc": semgrep_rc}),
    "bandit":  ({"status": "ok", "results": (bandit_doc or {}).get("results", [])}
                if bandit_ok else {"status": "error", "rc": bandit_rc}),
    "pytest":  load("/tmp/pytest.json"),
}))
PY
