#!/bin/sh
set -eu
# Render mounts its disk at runtime, after image-layer ownership is established.
# Prepare only the application's data directory, then drop root permanently.
DATA_DIR="${DATA_DIR:-/var/data/everlore}"
export DATA_DIR
if [ "$(id -u)" = 0 ]; then
  case "$DATA_DIR" in
    /var/data/everlore) ;;
    *) echo 'Container DATA_DIR must be /var/data/everlore.' >&2; exit 1 ;;
  esac
  if [ -L "$DATA_DIR" ]; then
    echo 'Container data directory must not be a symlink.' >&2
    exit 1
  fi
  mkdir -p "$DATA_DIR"
  chown -Rh node:node "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  exec gosu node "$@"
fi
exec "$@"
