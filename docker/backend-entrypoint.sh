#!/bin/sh
# Starts a Backstage backend with the config baked into the image, followed by
# any config files mounted into /app/config.d (applied in name order). That is
# how one image becomes several deployments, e.g. one per catalog shard.
set -eu

extra=""
for file in /app/config.d/*; do
  case "$file" in
    *.yaml | *.yml | *.json) extra="$extra --config $file" ;;
  esac
done

# shellcheck disable=SC2086 # $extra is a list of arguments
exec node "packages/${BACKSTAGE_PACKAGE:?BACKSTAGE_PACKAGE is not set}" \
  --config app-config.yaml \
  --config app-config.production.yaml \
  $extra "$@"
