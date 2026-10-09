#!/bin/sh
# Injects runtime config into index.html, which the Backstage frontend reads
# from <script type="backstage.io/config"> tags on startup (it overrides the
# config baked in at build time). This keeps the image environment-agnostic.
set -eu

: "${APP_BASE_URL:?APP_BASE_URL must be set}"
: "${BACKEND_BASE_URL:=$APP_BASE_URL}"

for value in "$APP_BASE_URL" "$BACKEND_BASE_URL"; do
  case "$value" in
    *[\"\\\<\>]*) echo "Refusing unsafe URL: $value" >&2; exit 1 ;;
  esac
done

config=$(printf '[{"context":"runtime","data":{"app":{"baseUrl":"%s"},"backend":{"baseUrl":"%s"}}}]' \
  "$APP_BASE_URL" "$BACKEND_BASE_URL")

awk -v tag="<script type=\"backstage.io/config\">${config}</script>" '{
  i = index($0, "</head>")
  if (i) { $0 = substr($0, 1, i - 1) tag substr($0, i) }
  print
}' /usr/share/nginx/index.html.template > /usr/share/nginx/html/index.html

echo "backstage: runtime config app.baseUrl=$APP_BASE_URL backend.baseUrl=$BACKEND_BASE_URL"
