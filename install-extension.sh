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
  echo "[ERROR] Expected VSIX not found: $(basename "$VSIX")"
  echo "        Run ./build.sh first so package.json version matches the package file."
  echo "        Refusing to fall back to a differently versioned .vsix."
  exit 1
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

install_vscode() {
  if ! command -v code >/dev/null 2>&1; then
    echo "[SKIP] VS Code CLI (code) not found in PATH."
    return 2
  fi
  echo "Installing to VS Code..."
  install_to_editor code "${HOME}/.vscode/extensions" "VS Code"
}

install_cursor() {
  if ! command -v cursor >/dev/null 2>&1; then
    echo "[SKIP] Cursor CLI (cursor) not found in PATH."
    return 2
  fi
  echo "Installing to Cursor..."
  install_to_editor cursor "${HOME}/.cursor/extensions" "Cursor"
}

# Return codes from install_* :
# 0 = success, 1 = install/verify failed, 2 = CLI missing (skip)
INSTALLED=0
FAILED=0
SKIPPED=0

run_target() {
  local fn="$1"
  local status=0
  set +e
  "$fn"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    INSTALLED=1
  elif [[ "$status" -eq 2 ]]; then
    SKIPPED=1
  else
    FAILED=1
  fi
}

case "$TARGET" in
  all)
    run_target install_vscode
    run_target install_cursor
    ;;
  vscode)
    run_target install_vscode
    ;;
  cursor)
    run_target install_cursor
    ;;
  *)
    echo "[ERROR] Unknown target: $TARGET"
    echo "        Usage: ./install-extension.sh [vscode|cursor|all]"
    exit 1
    ;;
esac

if [[ "$INSTALLED" -eq 0 ]]; then
  echo
  if [[ "$TARGET" == "all" && "$SKIPPED" -ne 0 && "$FAILED" -eq 0 ]]; then
    echo "[ERROR] No editor CLI found. Add one of these to PATH:"
    echo "  VS Code:  Command Palette -> \"Shell Command: Install 'code' command in PATH\""
    echo "  Cursor:   Command Palette -> \"Shell Command: Install 'cursor' command in PATH\""
  elif [[ "$FAILED" -ne 0 ]]; then
    echo "[ERROR] Install failed for target: $TARGET"
  else
    echo "[ERROR] No editor CLI found for target: $TARGET"
  fi
  exit 1
fi

if [[ "$TARGET" != "all" && "$FAILED" -ne 0 ]]; then
  echo
  echo "[ERROR] Install failed for target: $TARGET"
  exit 1
fi

if [[ "$TARGET" == "all" && "$FAILED" -ne 0 ]]; then
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
