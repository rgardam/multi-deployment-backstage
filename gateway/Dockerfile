# syntax=docker/dockerfile:1
#
# Edge gateway: the single entry point for browsers and for backend-to-backend
# traffic. Pure nginx config, so it builds in about a second.
#
#   docker build -f gateway/Dockerfile .
#
FROM nginxinc/nginx-unprivileged:1.30-alpine

# Fill ${NGINX_LOCAL_RESOLVERS} from /etc/resolv.conf at startup, so the same
# image resolves service names in Docker (127.0.0.11) and Kubernetes.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1

COPY gateway/default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080
