#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET="${1:-all}"
EXT_ID="OscarKing888.ace-code-search"
EXT_ID_LOWER="oscarking888.ace-code-search"
EXPECTED_VER="$(node -p "require('./package.json').version")"
VSIX="$SCRIPT_DIR/$(node -p "require('./package.json').name + '-' + require('./package.json').version + '.vsix'")"

if [[ ! -f "$VSIX" ]]; then
  mapfile -t VSIX_FILES < <(ls -t "$SCRIPT_DIR"/*.vsix 2>/dev/null || true)
  if [[ ${#VSIX_FILES[@]} -eq 0 ]]; then
    echo "[ERROR] No .vsix file found in this directory."
    echo "        Run ./build.sh first to generate the package."
    exit 1
  fi
  VSIX="${VSIX_FILES[0]}"
fi

echo "========================================"
echo " Ace Code Search - Install Extension (.vsix)"
echo "========================================"
echo
echo "Target version: $EXPECTED_VER"
echo "Installing: $(basename "$VSIX")"
echo

purge_extension_dirs() {
  local ext_root="$1"
  [[ -d "$ext_root" ]] || return 0
  local dir
  for dir in "$ext_root"/oscarking888.ace-code-search-* "$ext_root"/OscarKing888.ace-code-search-*; do
    [[ -d "$dir" ]] || continue
    echo "  Removing old folder: $(basename "$dir")"
    rm -rf "$dir"
  done
}

verify_installed_version() {
  local cli="$1"
  local label="$2"
  local installed_ver
  installed_ver="$("$cli" --list-extensions --show-versions | awk -F@ '/ace-code-search/ {print $2; exit}')"
  if [[ -z "$installed_ver" ]]; then
    echo "[ERROR] $label: extension not found after install."
    return 1
  fi
  if [[ "$installed_ver" != "$EXPECTED_VER" ]]; then
    echo "[ERROR] $label: expected v$EXPECTED_VER, got v$installed_ver"
    return 1
  fi
  echo "[OK] Installed to $label (v$installed_ver)."
}

install_to_editor() {
  local cli="$1"
  local ext_root="$2"
  local label="$3"
  purge_extension_dirs "$ext_root"
  "$cli" --uninstall-extension "$EXT_ID" >/dev/null 2>&1 || true
  "$cli" --uninstall-extension "$EXT_ID_LOWER" >/dev/null 2>&1 || true
  purge_extension_dirs "$ext_root"
  "$cli" --install-extension "$VSIX" --force
  verify_installed_version "$cli" "$label"
  purge_stale_extension_dirs "$ext_root" "$EXPECTED_VER"
}

purge_stale_extension_dirs() {
  local ext_root="$1"
  local keep_ver="$2"
  local dir
  [[ -d "$ext_root" ]] || return 0
  for dir in "$ext_root"/oscarking888.ace-code-search-* "$ext_root"/OscarKing888.ace-code-search-*; do
    [[ -d "$dir" ]] || continue
    [[ "$(basename "$dir")" == *"-$keep_ver" ]] && continue
    echo "  Removing stale folder: $(basename "$dir")"
    rm -rf "$dir"
  done
}

install_vscode() {
  if ! command -v code >/dev/null 2>&1; then
    echo "[SKIP] VS Code CLI (code) not found in PATH."
    return 1
  fi
  echo "Installing to VS Code..."
  install_to_editor code "${HOME}/.vscode/extensions" "VS Code"
}

install_cursor() {
  if ! command -v cursor >/dev/null 2>&1; then
    echo "[SKIP] Cursor CLI (cursor) not found in PATH."
    return 1
  fi
  echo "Installing to Cursor..."
  install_to_editor cursor "${HOME}/.cursor/extensions" "Cursor"
}

INSTALLED=0
FAILED=0

case "$TARGET" in
  all)
    install_vscode && INSTALLED=1 || FAILED=1
    install_cursor && INSTALLED=1 || FAILED=1
    ;;
  vscode)
    install_vscode && INSTALLED=1 || FAILED=1
    ;;
  cursor)
    install_cursor && INSTALLED=1 || FAILED=1
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
  exit 1
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo
  echo "[ERROR] At least one editor install failed."
  exit 1
fi

echo
echo "========================================"
echo " Extension installed successfully (v$EXPECTED_VER)."
echo " Fully quit and restart VS Code / Cursor."
echo " Panel status should show: Ready · v$EXPECTED_VER"
echo "========================================"
