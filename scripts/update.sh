#!/usr/bin/env bash
# Pulls the latest code and rebuilds, stamping the image with the commit it was built from.
#   ./scripts/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
docker compose ps
