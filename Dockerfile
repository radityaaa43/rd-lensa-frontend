# Lensa image: server + web, built from this repo alone (sibling code is in server/vendor).
# No secret, no state and no cluster tooling goes into the image: kubectl, docker and the iroha CLI are not installed (opa is: one pinned public
# binary, a rego tester / tar tool for the Kebijakan page; it holds and uses no signing key, the party sinks sign),
# server/state is an empty mount point (mode 700). Config and credentials arrive as env and mounted Secrets (final-design/lensa/PLAN.md).
# NODE_IMAGE is passed by CI as node@sha256:<digest> so the base is pinned for each build.
ARG NODE_IMAGE=node:22-bookworm-slim
# The only opa: official release, sha256 pinned here (single source: image-checks.sh and the CI test read these lines) and verified in the build stage below.
ARG OPA_VERSION=v1.21.1
ARG OPA_SHA256=668506eb17a2eaa1fce6cc0d1f42ef85125d4ac5bda5fc74d1152d0c77145031

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

FROM ${NODE_IMAGE} AS opa
ARG OPA_VERSION
ARG OPA_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /opa "https://github.com/open-policy-agent/opa/releases/download/${OPA_VERSION}/opa_linux_amd64_static" \
 && echo "${OPA_SHA256}  /opa" | sha256sum -c -

FROM ${NODE_IMAGE} AS runtime
# python3 runs server/src/adapters/iroha3-intent.py (public DvP terms, no key).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
# CMD is tsx; npm, npx and corepack are never used at runtime. Their bundled docs carry text that matches a private-key scan and the pod does not need a package manager.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm /root/.cache /usr/local/share/.cache /tmp/*
ENV NODE_ENV=production PORT=8790
WORKDIR /app/frontend
COPY --from=server-deps /app/frontend/node_modules node_modules
COPY --from=opa --chown=0:0 --chmod=0555 /opa /usr/local/bin/opa
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
