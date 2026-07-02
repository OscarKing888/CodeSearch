#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo " Code Search - Install Dependencies"
echo "========================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Install Node.js 18+ (https://nodejs.org/) or use: brew install node"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm not found."
  exit 1
fi

echo "Node.js: $(node -v)"
echo "npm:     $(npm -v)"
echo

if [[ "$(uname)" == "Darwin" ]]; then
  if ! xcode-select -p >/dev/null 2>&1; then
    echo "[WARN] Xcode Command Line Tools not detected."
    echo "       better-sqlite3 needs them. Run: xcode-select --install"
    echo
  fi
fi

echo "[1/3] Running npm install..."
echo "      On macOS, native modules require Xcode Command Line Tools."
echo
npm install

echo.
echo "[2/3] Rebuilding better-sqlite3 for VS Code / Cursor Electron..."
echo "      (native module must match editor Electron, not system Node.js)"
node "$SCRIPT_DIR/scripts/rebuild-electron.js" vscode

echo
echo "[3/3] Optional: rebuild for CLI on system Node.js"
echo "      Skip this if you only use the VS Code extension."
npm rebuild better-sqlite3 || echo "[WARN] System Node rebuild failed. CLI (ess) may not work; extension is unaffected."

echo
echo "========================================"
echo " Install completed successfully."
echo " Next: ./build.sh, then ./install-extension.sh"
echo "========================================"
