# Verdikt worker on Fly.io.
# Runs the Node verdict engine PLUS its own Docker daemon (the engine shells out to
# `docker run` for the network-isolated code sandbox). Fly machines are Firecracker VMs
# where we are root, so a dockerd can run inside the machine (we do not need the host socket).
FROM docker:27-dind

# Node for the worker server.
RUN apk add --no-cache nodejs npm

WORKDIR /app

# Worker deps (all pure-JS: express, viem, @anthropic-ai/sdk, @circle-fin/*, @vercel/postgres).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled server + the sandbox build context (the runner image is built at boot).
COPY dist ./dist
COPY sandbox ./sandbox

# Demo task fixtures (code/answer/schema) read by the /api/demo route.
COPY fixtures ./fixtures

COPY fly-entrypoint.sh /usr/local/bin/fly-entrypoint.sh
RUN chmod +x /usr/local/bin/fly-entrypoint.sh

ENV RUNNER_IMAGE=verdikt-runner
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/fly-entrypoint.sh"]
