#!/bin/sh
# A foreground wrapper around Everlore's durable quality sessions. No agent
# recursion, branch changes, stashes, commits, deployment or paid requests.
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -eq 0 ]; then
  exec sh scripts/run.sh lab help
fi
exec sh scripts/run.sh lab "$@"
