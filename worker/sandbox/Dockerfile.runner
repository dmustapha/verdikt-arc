# Sandbox image that runs payer tests + static scanners over an untrusted artifact.
FROM python:3.12-slim

RUN pip install --no-cache-dir pytest==8.* pytest-json-report==1.5.* semgrep==1.* bandit==1.*

# DEV-003: bake the registry rulesets into the image at build time (network is available during
# `docker build`). At RUN time the container is started with --network=none for isolation, so
# semgrep cannot reach the registry — pointing --config at these local YAMLs keeps the SQLi
# static evidence AND avoids semgrep stalling ~90s on a doomed offline registry fetch.
RUN mkdir -p /rules \
 && python3 -c "import urllib.request; open('/rules/sql-injection.yml','wb').write(urllib.request.urlopen('https://semgrep.dev/c/p/sql-injection').read())" \
 && python3 -c "import urllib.request; open('/rules/security-audit.yml','wb').write(urllib.request.urlopen('https://semgrep.dev/c/p/security-audit').read())"

COPY runner.sh /runner.sh
RUN chmod +x /runner.sh

# Non-root for defense-in-depth; the host adds --network=none + resource caps.
RUN useradd -m runner
USER runner

ENTRYPOINT ["/runner.sh"]
