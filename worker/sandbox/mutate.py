#!/usr/bin/env python3
# Bounded, self-contained mutation tester (D1). Grades the PAYER's test suite: it mutates the
# seller's solution.py with simple operators and checks whether the payer's tests catch each mutation.
# A surviving mutant = an assertion that tests nothing → the "passes tests" signal is weak.
#   killed   = tests failed on the mutant (good: the suite caught the change)
#   survived = tests still passed on the mutant (bad: the suite is blind to it)
#   mutation_score = killed / total
# Reads /work (read-only mount), works in a writable /tmp copy, prints ONE JSON line. Never throws.
import json, os, re, shutil, subprocess, sys

WORK = '/work'
TMP = '/tmp/mut'
MAX_MUTANTS = int(os.environ.get('MUTATION_MAX', '8'))
PER_TEST_TIMEOUT = 8

# (regex, replacement) textual operators. Each produces one mutant per matched occurrence.
OPERATORS = [
    (r' \+ ', ' - '), (r' - ', ' + '), (r' \* ', ' / '),
    (r' == ', ' != '), (r' != ', ' == '),
    (r' < ', ' >= '), (r' > ', ' <= '), (r' <= ', ' > '), (r' >= ', ' < '),
    (r' and ', ' or '), (r' or ', ' and '),
    (r'\bTrue\b', 'False'), (r'\bFalse\b', 'True'),
]

def run_tests(cwd):
    try:
        r = subprocess.run([sys.executable, '-m', 'pytest', '-q', '-x'], cwd=cwd,
                           capture_output=True, timeout=PER_TEST_TIMEOUT)
        return r.returncode == 0  # True = tests passed
    except Exception:
        return None  # could not run (timeout/error) → treat as inconclusive, skip mutant

def main():
    sol = os.path.join(WORK, 'solution.py')
    if not os.path.exists(sol):
        print(json.dumps({'skip': 'no solution.py'})); return
    shutil.rmtree(TMP, ignore_errors=True)
    shutil.copytree(WORK, TMP)
    msol = os.path.join(TMP, 'solution.py')
    original = open(msol).read()

    # Baseline must be green, else mutation scoring is meaningless.
    base = run_tests(TMP)
    if base is not True:
        print(json.dumps({'skip': 'baseline tests not passing'})); return

    # Generate bounded mutants: walk operators, mutate first occurrence not already mutated.
    mutants = []
    for pat, rep in OPERATORS:
        for m in re.finditer(pat, original):
            mutated = original[:m.start()] + rep + original[m.end():]
            if mutated != original:
                mutants.append(mutated)
            if len(mutants) >= MAX_MUTANTS:
                break
        if len(mutants) >= MAX_MUTANTS:
            break

    if not mutants:
        print(json.dumps({'total': 0, 'killed': 0, 'survived': 0, 'score': 1.0, 'note': 'no mutable operators'})); return

    killed = survived = inconclusive = 0
    for mutated in mutants:
        open(msol, 'w').write(mutated)
        res = run_tests(TMP)
        if res is None:
            inconclusive += 1
        elif res is False:
            killed += 1      # tests failed → mutant caught
        else:
            survived += 1    # tests passed → blind spot
    open(msol, 'w').write(original)

    scored = killed + survived
    score = (killed / scored) if scored else 1.0
    print(json.dumps({'total': scored, 'killed': killed, 'survived': survived,
                      'inconclusive': inconclusive, 'score': round(score, 3)}))

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'skip': f'mutate error: {str(e)[:120]}'}))
