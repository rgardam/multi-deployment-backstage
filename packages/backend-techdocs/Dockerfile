# syntax=docker/dockerfile:1
#
# backend-techdocs image. Serves and generates TechDocs sites.
#
# TechDocs runs MkDocs in-process, so this is the one image that needs Python
# (which is exactly why every backend has its own Dockerfile). It starts from
# the official Python image and copies in the Node.js binary; both are Debian
# trixie, so this needs no apt and stays fast to build.
#
# Like the other backends the bundle is built on the host first
# (`task bundle:backend-techdocs`). Build from the repository root:
#
#   docker build -f packages/backend-techdocs/Dockerfile .
#
ARG NODE_VERSION=24
ARG PYTHON_VERSION=3.13
FROM node:${NODE_VERSION}-trixie-slim AS node

FROM python:${PYTHON_VERSION}-slim-trixie

COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN groupadd --gid 1000 node && \
    useradd --uid 1000 --gid node --create-home node

# MkDocs first: it changes far less often than the code
ARG MKDOCS_TECHDOCS_CORE_VERSION=1.7.1
RUN --mount=type=cache,target=/root/.cache/pip \
    --mount=type=secret,id=extra_ca \
    if [ -f /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi; \
    python -m venv /opt/mkdocs && \
    /opt/mkdocs/bin/pip install "mkdocs-techdocs-core==${MKDOCS_TECHDOCS_CORE_VERSION}"
ENV PATH="/opt/mkdocs/bin:${PATH}"

ENV NODE_ENV=production \
    BACKSTAGE_PACKAGE=backend-techdocs \
    YARN_GLOBAL_FOLDER=/home/node/.cache/yarn \
    # Copy files into the layer: hardlinks cannot reach the build cache
    YARN_NM_MODE=classic

USER node
WORKDIR /app

# Dependency layer: rebuilt only when this backend's production dependencies
# change. `task bundle:backend-techdocs` writes dist/deps: the manifests this
# backend needs plus a lockfile pruned to them. There is no global yarn in
# this image, so run the repository's pinned release.
COPY --chown=node:node .yarn/releases ./.yarn/releases
COPY --chown=node:node .yarnrc.yml backstage.json ./
COPY --chown=node:node packages/backend-techdocs/dist/deps/ ./
RUN --mount=type=cache,target=/home/node/.cache/yarn,sharing=shared,uid=1000,gid=1000 \
    --mount=type=secret,id=extra_ca,uid=1000 \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    node .yarn/releases/yarn-*.cjs workspaces focus --all --production

# Application layer: a few MB that change on every code change.
COPY --chown=node:node app-config.yaml app-config.production.yaml ./
# Demo documentation sources, referenced by `dir:` techdocs refs
COPY --chown=node:node examples ./examples
COPY --chown=node:node packages/backend-techdocs/dist/bundle.tar.gz ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz
COPY --chmod=755 docker/backend-entrypoint.sh /usr/local/bin/backstage-backend

EXPOSE 7007
ENTRYPOINT ["backstage-backend"]
