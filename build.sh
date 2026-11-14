#!/usr/bin/env bash
# Tests the simulation core, compiles it to WebAssembly and copies it into web/.
set -euo pipefail
cd "$(dirname "$0")/sim-core"
cargo test --release
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/sim_core.wasm ../web/
echo "Built web/sim_core.wasm ($(wc -c < ../web/sim_core.wasm) bytes). Serve web/ with any static server."
