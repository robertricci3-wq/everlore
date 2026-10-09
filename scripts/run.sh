#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
runtime_root="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if ! command -v node >/dev/null 2>&1 && [ -x "$runtime_root/node/bin/node" ]; then
  PATH="$runtime_root/node/bin:$PATH"
fi
if ! command -v pnpm >/dev/null 2>&1 && [ -x "$runtime_root/bin/fallback/pnpm" ]; then
  PATH="$runtime_root/bin/fallback:$PATH"
fi
export PATH
if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  echo 'Everlore needs Node.js 24 or newer and pnpm. Install those, then run this script again.' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node.js 24 or newer is required."); process.exit(1); }'
if [ ! -d node_modules ]; then
  echo 'Installing the locked application dependencies...'
  pnpm install --frozen-lockfile
fi
exec pnpm "${1:-dev}"
