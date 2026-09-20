#!/usr/bin/env bash
# One-command demo: brain server (real graph if prepared, else synthetic) + web UI.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f brain/outputs/malecns_v1/graph.npz ] && [ ! -f brain/outputs/synthetic/graph.npz ]; then
  echo "No graph yet: building the synthetic demo graph (run 'cd brain && uv run python -m flybrain.setup' for the real one)."
  (cd brain && uv sync && uv run python -m flybrain.synthetic)
fi
(cd brain && uv run python -m flybrain.server "$@") &
BRAIN=$!
trap 'kill $BRAIN 2>/dev/null; wait $BRAIN 2>/dev/null' EXIT INT TERM
(cd web && [ -d node_modules ] || npm install)
echo "brain: ws://127.0.0.1:8766/ws   web: http://localhost:5173"
(cd web && npx vite --port 5173)
