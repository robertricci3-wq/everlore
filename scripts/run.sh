#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
command_name="${1:-dev}"
if [ "$#" -gt 0 ]; then shift; fi
runtime_root="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if ! command -v node >/dev/null 2>&1 && [ -x "$runtime_root/node/bin/node" ]; then
  PATH="$runtime_root/node/bin:$PATH"
fi
if ! command -v pnpm >/dev/null 2>&1 && [ -x "$runtime_root/bin/fallback/pnpm" ]; then
  PATH="$runtime_root/bin/fallback:$PATH"
fi
export PATH
if ! command -v node >/dev/null 2>&1; then
  echo 'Everlore needs Node.js 24 or newer and pnpm. Install those, then run this script again.' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node.js 24 or newer is required."); process.exit(1); }'
# The deployed Lab uses the dependencies installed in the image. Invoking a
# package manager here could try to modify immutable /app or access the network.
if [ "$command_name" = lab ]; then
  if [ ! -d node_modules ]; then
    echo 'Install the locked application dependencies before running the Lab.' >&2
    exit 1
  fi
  exec node --import tsx scripts/lab.ts "$@"
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo 'Everlore needs pnpm. Install it, then run this script again.' >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo 'Installing the locked application dependencies...'
  pnpm install --frozen-lockfile
fi
exec pnpm "$command_name" "$@"
