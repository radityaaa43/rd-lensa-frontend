# Lensa image: server + web, built from this repo alone (sibling code is in server/vendor).
# No secret, no state and no cluster tooling goes into the image: kubectl, docker, opa and the iroha CLI are not installed,
# server/state is an empty mount point (mode 700). Config and credentials arrive as env and mounted Secrets (final-design/lensa/PLAN.md).
# NODE_IMAGE is passed by CI as node@sha256:<digest> so the base is pinned for each build.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS web
WORKDIR /app/frontend
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY server/vendor server/vendor
RUN npm ci --no-audit --no-fund
# web type-checks against the shared types in server/src (adapter.ts, domain.ts, policy/types.ts)
COPY server/src server/src
COPY web web
RUN npm run build -w web

FROM ${NODE_IMAGE} AS server-deps
WORKDIR /app/frontend
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY server/vendor server/vendor
RUN npm ci --omit=dev --workspace=server --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
# python3 runs server/src/adapters/iroha3-intent.py (public DvP terms, no key).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
# CMD is tsx; npm, npx and corepack are never used at runtime. Their bundled docs carry text that matches a private-key scan and the pod does not need a package manager.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production PORT=8790
WORKDIR /app/frontend
COPY --from=server-deps /app/frontend/node_modules node_modules
COPY package.json ./
COPY server/package.json server/tsconfig.json server/
COPY server/src server/src
COPY server/vendor server/vendor
COPY --from=web /app/frontend/web/dist web/dist
RUN install -d -m 700 -o 10001 -g 10001 server/state
USER 10001:10001
WORKDIR /app/frontend/server
EXPOSE 8790
CMD ["../node_modules/.bin/tsx", "src/main.ts"]
