#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET="${1:-all}"

echo "========================================"
echo " Code Search - Build Extension"
echo "========================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "node_modules not found. Running install.sh..."
  bash "$SCRIPT_DIR/install.sh"
  echo
fi

echo "[1/4] Rebuilding better-sqlite3 for editor Electron..."
node "$SCRIPT_DIR/scripts/rebuild-electron.js" "$TARGET"

echo
echo "[2/4] Building extension (esbuild)..."
npm run build

echo
echo "[3/4] Running tests..."
npm test

echo
echo "[4/4] Packaging VSIX..."
npx --yes @vscode/vsce package --allow-missing-repository --baseContentUrl https://github.com/OscarKing888/CodeSearch

VSIX="$(node -p "require('./package.json').name + '-' + require('./package.json').version + '.vsix'")"

if [[ ! -f "$VSIX" ]]; then
  echo "[ERROR] Expected package file not found: $VSIX"
  exit 1
fi

echo
echo "========================================"
echo " Build completed successfully."
echo
echo " Output:"
echo "   dist/extension.js"
echo "   dist/webview/main.js"
echo "   $VSIX"
echo
echo " Debug: open this folder in VS Code / Cursor and press F5"
echo " Install: ./install-extension.sh"
echo "========================================"
