# syntax=docker/dockerfile:1
#
# Frontend image: the static app bundle served by nginx. No Node.js at runtime
# and no dependency install at build time; the bundle is built on the host
# (`task bundle:app`) and copied in.
#
# The same image runs in every environment: app.baseUrl and backend.baseUrl
# are injected into index.html at container start (see docker/).
#
#   docker build -f packages/app/Dockerfile .
#
FROM nginxinc/nginx-unprivileged:1.30-alpine

COPY packages/app/docker/default.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 packages/app/docker/40-backstage-runtime-config.sh /docker-entrypoint.d/
COPY --chown=101:101 packages/app/dist /usr/share/nginx/html
COPY --chown=101:101 packages/app/dist/index.html /usr/share/nginx/index.html.template

EXPOSE 8080
