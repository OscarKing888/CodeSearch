#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET="${1:-all}"

echo "========================================"
echo " Ace Code Search - Build Extension"
echo "========================================"
echo

echo "Removing old .vsix packages..."
rm -f "$SCRIPT_DIR"/*.vsix
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found."
  exit 1
fi

node "$SCRIPT_DIR/scripts/check-node-version.js"

ARCH="$(node -p "process.arch")"
PLATFORM="$(node -p "process.platform")"
echo "Node: $(node -v)  platform=$PLATFORM  arch=$ARCH"

if [[ "$PLATFORM" == "darwin" ]]; then
  UNAME_ARCH="$(uname -m)"
  if [[ "$UNAME_ARCH" == "arm64" && "$ARCH" == "x64" ]]; then
    echo "[WARN] Running x64 Node under Rosetta on Apple Silicon."
    echo "       Electron native binaries will be tagged darwin-x64-*, not darwin-arm64-*."
    echo "       Prefer a native arm64 Node.js install for local Cursor/VS Code packages."
  fi
fi

if [[ ! -d node_modules ]]; then
  echo "node_modules not found. Running install.sh..."
  bash "$SCRIPT_DIR/install.sh"
  echo
fi

case "$TARGET" in
  all|vscode|cursor)
    ;;
  *)
    echo "[ERROR] Unknown target: $TARGET"
    echo "        Usage: ./build.sh [all|vscode|cursor]"
    exit 1
    ;;
esac

echo "[1/5] Building extension (esbuild)..."
npm run build

echo
echo "[2/5] Running tests..."
node "$SCRIPT_DIR/scripts/rebuild-node.js"
npm test

echo
echo "[3/5] Rebuilding better-sqlite3 for editor Electron..."
node "$SCRIPT_DIR/scripts/rebuild-electron.js" "$TARGET"

echo
echo "[4/5] Packaging VSIX..."
npm run package

VSIX="$(node -p "require('./package.json').name + '-' + require('./package.json').version + '.vsix'")"

if [[ ! -f "$VSIX" ]]; then
  echo "[ERROR] Expected package file not found: $VSIX"
  exit 1
fi

echo
echo "[5/5] Restoring better-sqlite3 for system Node (CLI / MCP)..."
node "$SCRIPT_DIR/scripts/rebuild-node.js"

echo
echo "========================================"
echo " Build completed successfully."
echo
echo " Output:"
echo "   dist/extension.js"
echo "   dist/webview/main.js"
echo "   dist/mcp.js"
echo "   $VSIX"
echo
echo " Debug: open this folder in VS Code / Cursor and press F5"
echo " Install: ./install-extension.sh"
echo " MCP:     npm run mcp -- --db <index.db>"
echo "========================================"

echo
bash "$SCRIPT_DIR/install-extension.sh" "$TARGET"
