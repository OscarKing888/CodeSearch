#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ $# -lt 1 ]]; then
  echo "Usage:"
  echo "  ./bump-version.sh 0.2.1 --notes \"Fix Electron ABI 146 native packaging.\""
  echo
  echo "Equivalent to:"
  echo "  npm run version:bump -- 0.2.1 --notes \"Fix Electron ABI 146 native packaging.\""
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm not found. Please install Node.js with npm."
  exit 1
fi

npm run version:bump -- "$@"
