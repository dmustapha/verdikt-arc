#!/bin/sh
# Boot sequence for the Verdikt worker on a Fly machine:
#   1. start dockerd inside the VM (vfs storage driver: reliable in Firecracker, no overlay)
#   2. wait for the daemon socket
#   3. build the verdikt-runner sandbox image (network is available at boot)
#   4. exec the Node verdict server
set -e

echo "[boot] starting dockerd..."
# The docker:dind image ships dockerd-entrypoint.sh; vfs avoids overlayfs issues in the VM.
# Explicit DNS so build/run containers can resolve (the VM's resolv.conf is not inherited
# by the nested bridge by default, which broke pip/semgrep fetches on first boot).
# --iptables=false: the sandbox never needs docker's bridge NAT (builds use --network=host,
# verdict runs use --network=none), and letting dockerd rewrite the VM's iptables breaks the
# host node process's outbound HTTPS to api.anthropic.com ("Premature close"). Disabling it
# keeps the verdict reasoner reachable while the host-net build and no-net run still work.
dockerd-entrypoint.sh dockerd --storage-driver=overlay2 --iptables=false --dns 8.8.8.8 --dns 1.1.1.1 >/var/log/dockerd.log 2>&1 &

echo "[boot] waiting for docker daemon..."
for i in $(seq 1 90); do
  if docker info >/dev/null 2>&1; then echo "[boot] docker ready after ${i}s"; break; fi
  sleep 1
done
if ! docker info >/dev/null 2>&1; then
  echo "[boot] FATAL: dockerd did not come up"; tail -n 50 /var/log/dockerd.log; exit 1
fi

echo "[boot] building verdikt-runner sandbox image..."
n=0
# DOCKER_BUILDKIT=0 uses the classic builder, whose RUN steps inherit the daemon's --dns
# (8.8.8.8). --network=host additionally puts the build on the VM's network namespace.
# Together they fix the nested-build DNS failure (pip/semgrep fetch). The sandbox RUN at
# verdict time still uses --network=none for isolation.
export DOCKER_BUILDKIT=0
until docker build --network=host -t verdikt-runner /app/sandbox; do
  n=$((n+1)); [ "$n" -ge 3 ] && { echo "[boot] FATAL: runner image build failed after 3 tries"; exit 1; }
  echo "[boot] runner build failed, retry $n/3..."; sleep 5
done
echo "[boot] runner image ready"

echo "[boot] starting verdikt-worker on :${PORT:-8080}"
exec node dist/server.js
