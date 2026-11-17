#!/usr/bin/env bash
set -euo pipefail

sidecar_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
release_dir="${CARGO_TARGET_DIR:-$sidecar_dir/target}/release"
staging_dir="$sidecar_dir/../resources/sidecar"

cargo build --release --locked --manifest-path "$sidecar_dir/Cargo.toml"
install -Dm755 "$release_dir/syntee-sidecar" "$staging_dir/syntee-sidecar"
