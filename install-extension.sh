#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET="${1:-all}"

echo "========================================"
echo " Ace Code Search - Install Extension (.vsix)"
echo "========================================"
echo

mapfile -t VSIX_FILES < <(ls -t "$SCRIPT_DIR"/*.vsix 2>/dev/null || true)

if [[ ${#VSIX_FILES[@]} -eq 0 ]]; then
  echo "[ERROR] No .vsix file found in this directory."
  echo "        Run ./build.sh first to generate the package."
  exit 1
fi

VSIX="${VSIX_FILES[0]}"
echo "Installing: $(basename "$VSIX")"
echo

install_vscode() {
  if ! command -v code >/dev/null 2>&1; then
    echo "[SKIP] VS Code CLI (code) not found in PATH."
    return 1
  fi
  echo "Installing to VS Code..."
  code --install-extension "$VSIX" --force
  echo "[OK] Installed to VS Code."
}

install_cursor() {
  if ! command -v cursor >/dev/null 2>&1; then
    echo "[SKIP] Cursor CLI (cursor) not found in PATH."
    return 1
  fi
  echo "Installing to Cursor..."
  cursor --install-extension "$VSIX" --force
  echo "[OK] Installed to Cursor."
}

INSTALLED=0

case "$TARGET" in
  all)
    install_vscode && INSTALLED=1 || true
    install_cursor && INSTALLED=1 || true
    ;;
  vscode)
    install_vscode && INSTALLED=1
    ;;
  cursor)
    install_cursor && INSTALLED=1
    ;;
  *)
    echo "[ERROR] Unknown target: $TARGET"
    echo "       Usage: ./install-extension.sh [vscode|cursor|all]"
    exit 1
    ;;
esac

if [[ "$INSTALLED" -eq 0 ]]; then
  echo
  echo "[ERROR] No editor CLI found. Add one of these to PATH:"
  echo "  VS Code:  Command Palette -> \"Shell Command: Install 'code' command in PATH\""
  echo "  Cursor:   Command Palette -> \"Shell Command: Install 'cursor' command in PATH\""
  echo
  echo "You can still install manually:"
  echo "  code --install-extension \"$VSIX\""
  echo "  cursor --install-extension \"$VSIX\""
  exit 1
fi

echo
echo "========================================"
echo " Extension installed successfully."
echo " Restart VS Code / Cursor, then search:"
echo "   Commands:  \"Ace Code Search\""
echo "   Settings:  \"sourceSearch\""
echo "   Panel tab: \"Ace Code Search\" (bottom)"
echo "========================================"
