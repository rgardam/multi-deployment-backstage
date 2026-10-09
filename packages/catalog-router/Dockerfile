# syntax=docker/dockerfile:1
#
# catalog-router image: plain Node, no node_modules. The shared shard rules
# are inlined into dist/ at build time (`task bundle:catalog-router`), so the
# image is a base image plus a few compiled files and builds in seconds.
#
#   docker build -f packages/catalog-router/Dockerfile .
#
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY packages/catalog-router/dist ./dist

USER node
EXPOSE 7007
CMD ["node", "dist/index.cjs.js"]
