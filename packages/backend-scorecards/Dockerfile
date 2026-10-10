# syntax=docker/dockerfile:1
#
# backend-scorecards image. Hosts the local scorecards plugin
# (plugins/scorecards-backend) as its own deployment.
#
# Thin by design: the bundle is built on the host first
# (`task bundle:backend-scorecards`, i.e. `yarn workspace backend-scorecards build`), so the image
# only installs production dependencies and unpacks the bundle. Build from the
# repository root:
#
#   docker build -f packages/backend-scorecards/Dockerfile .
#
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-trixie-slim

ENV NODE_ENV=production \
    BACKSTAGE_PACKAGE=backend-scorecards \
    YARN_GLOBAL_FOLDER=/home/node/.cache/yarn \
    # Copy files into the layer: hardlinks cannot reach the build cache
    YARN_NM_MODE=classic

USER node
WORKDIR /app

# Dependency layer: rebuilt only when this backend's production dependencies
# change. `task bundle:backend-scorecards` writes dist/deps: the manifests this backend
# needs plus a lockfile pruned to them, so the install only pulls this
# backend's plugins and other backends' upgrades don't invalidate the layer.
COPY --chown=node:node .yarn/releases ./.yarn/releases
COPY --chown=node:node .yarnrc.yml backstage.json ./
COPY --chown=node:node packages/backend-scorecards/dist/deps/ ./
RUN --mount=type=cache,target=/home/node/.cache/yarn,sharing=shared,uid=1000,gid=1000 \
    --mount=type=secret,id=extra_ca,uid=1000 \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    yarn workspaces focus --all --production

# Application layer: a few MB that change on every code change.
COPY --chown=node:node app-config.yaml app-config.production.yaml ./
COPY --chown=node:node packages/backend-scorecards/dist/bundle.tar.gz ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz
COPY --chmod=755 docker/backend-entrypoint.sh /usr/local/bin/backstage-backend

EXPOSE 7007
ENTRYPOINT ["backstage-backend"]
