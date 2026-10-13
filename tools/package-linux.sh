#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
docker build -f tools/Dockerfile.desktop -t hdlview-desktop-builder:1.90 .
mkdir -p target/package-cargo "${CARGO_HOME:-$HOME/.cargo}/registry"
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/work" \
  --mount "type=bind,src=${CARGO_HOME:-$HOME/.cargo}/registry,dst=/work/target/package-cargo/registry" \
  --env CARGO_HOME=/work/target/package-cargo --env CARGO_TARGET_DIR=/work/target/desktop-release --env CARGO_BUILD_JOBS=4 \
  hdlview-desktop-builder:1.90 bash tools/package-in-container.sh
