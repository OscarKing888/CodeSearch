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

# Resolve a CLI path to its real filesystem location (follow symlinks).
realpath_cli() {
  local path="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "$path" 2>/dev/null && return 0
  fi
  local python_bin=""
  if command -v python3 >/dev/null 2>&1; then
    python_bin="python3"
  elif command -v python >/dev/null 2>&1; then
    python_bin="python"
  fi
  if [[ -n "$python_bin" ]]; then
    "$python_bin" -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$path" 2>/dev/null && return 0
  fi
  # Fallback: readlink -f (GNU) or manual loop for macOS.
  if readlink -f "$path" >/dev/null 2>&1; then
    readlink -f "$path"
    return 0
  fi
  local cur="$path"
  local next=""
  local i=0
  while [[ -L "$cur" && "$i" -lt 32 ]]; do
    next="$(readlink "$cur")"
    if [[ "$next" != /* ]]; then
      next="$(cd "$(dirname "$cur")" && pwd)/$next"
    fi
    cur="$next"
    i=$((i + 1))
  done
  echo "$cur"
}

# Return 0 if the CLI binary belongs to Cursor (not Microsoft VS Code).
is_cursor_cli() {
  local resolved
  resolved="$(realpath_cli "$1")"
  [[ "$resolved" == *"/Cursor.app/"* || "$resolved" == *"/cursor.app/"* ]] && return 0
  [[ "$resolved" == *"/Cursor/"* || "$resolved" == *"/cursor/resources/app/"* ]] && return 0
  return 1
}

# Return 0 if the CLI binary belongs to Microsoft VS Code.
is_vscode_cli() {
  local resolved
  resolved="$(realpath_cli "$1")"
  if is_cursor_cli "$resolved"; then
    return 1
  fi
  [[ "$resolved" == *"/Visual Studio Code.app/"* ]] && return 0
  [[ "$resolved" == *"/Visual Studio Code - Insiders.app/"* ]] && return 0
  [[ "$resolved" == *"/Microsoft VS Code/"* ]] && return 0
  [[ "$resolved" == *"/usr/share/code/"* || "$resolved" == *"/usr/lib/code/"* ]] && return 0
  # Last resort: product.json next to the CLI (VS Code ships "Microsoft Corporation").
  local app_dir
  app_dir="$(cd "$(dirname "$resolved")/.." && pwd)"
  if [[ -f "$app_dir/product.json" ]] && grep -q '"nameShort"[[:space:]]*:[[:space:]]*"Code"' "$app_dir/product.json" 2>/dev/null; then
    return 0
  fi
  if [[ -f "$app_dir/product.json" ]] && grep -q 'Microsoft Corporation' "$app_dir/product.json" 2>/dev/null; then
    return 0
  fi
  return 1
}

# Prefer editor app-bundle CLIs over PATH shims. Cursor often installs a
# /usr/local/bin/code symlink that hijacks the VS Code command name.
resolve_vscode_cli() {
  local candidate=""
  local resolved=""
  for candidate in \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
    "/usr/share/code/bin/code" \
    "/usr/lib/code/bin/code"
  do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  if command -v code >/dev/null 2>&1; then
    candidate="$(command -v code)"
    if is_vscode_cli "$candidate"; then
      echo "$candidate"
      return 0
    fi
    resolved="$(realpath_cli "$candidate")"
    echo "[WARN] PATH 'code' points to Cursor/other editor, not VS Code:" >&2
    echo "       $candidate -> $resolved" >&2
  fi
  return 1
}

resolve_cursor_cli() {
  local candidate=""
  for candidate in \
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
    "/Applications/Cursor.app/Contents/Resources/app/bin/code"
  do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  if command -v cursor >/dev/null 2>&1; then
    candidate="$(command -v cursor)"
    if is_cursor_cli "$candidate"; then
      echo "$candidate"
      return 0
    fi
  fi
  # Accept PATH "code" only when it is actually Cursor (common on macOS).
  if command -v code >/dev/null 2>&1; then
    candidate="$(command -v code)"
    if is_cursor_cli "$candidate"; then
      echo "$candidate"
      return 0
    fi
  fi
  return 1
}

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
  local ext_root="$3"
  local installed_ver=""
  local found_dir=""

  installed_ver="$("$cli" --list-extensions --show-versions 2>/dev/null | awk -F@ '/ace-code-search/ {print $2; exit}')"
  if [[ -z "$installed_ver" ]]; then
    echo "[ERROR] $label: extension not found after install (CLI list)."
    return 1
  fi
  if [[ "$installed_ver" != "$EXPECTED_VER" ]]; then
    echo "[ERROR] $label: expected v$EXPECTED_VER, got v$installed_ver"
    return 1
  fi

  for found_dir in \
    "$ext_root/oscarking888.ace-code-search-$EXPECTED_VER" \
    "$ext_root/OscarKing888.ace-code-search-$EXPECTED_VER"
  do
    if [[ -d "$found_dir" ]]; then
      echo "[OK] Installed to $label (v$installed_ver)."
      echo "     CLI: $cli"
      echo "     Dir: $found_dir"
      return 0
    fi
  done

  echo "[ERROR] $label: CLI reports v$installed_ver, but extension folder is missing under:"
  echo "        $ext_root"
  echo "        This usually means the CLI targeted a different editor (e.g. PATH 'code' -> Cursor)."
  return 1
}

install_to_editor() {
  local cli="$1"
  local ext_root="$2"
  local label="$3"
  echo "  Using CLI: $cli"
  echo "  Extensions: $ext_root"
  purge_extension_dirs "$ext_root"
  "$cli" --uninstall-extension "$EXT_ID" >/dev/null 2>&1 || true
  "$cli" --uninstall-extension "$EXT_ID_LOWER" >/dev/null 2>&1 || true
  purge_extension_dirs "$ext_root"
  "$cli" --install-extension "$VSIX" --force
  verify_installed_version "$cli" "$label" "$ext_root"
  purge_stale_extension_dirs "$ext_root" "$EXPECTED_VER"
}

install_vscode() {
  local cli=""
  if ! cli="$(resolve_vscode_cli)"; then
    echo "[SKIP] VS Code CLI not found (or PATH 'code' is Cursor)."
    echo "       Install VS Code, or use the app bundle CLI:"
    echo "       /Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    return 2
  fi
  echo "Installing to VS Code..."
  install_to_editor "$cli" "${HOME}/.vscode/extensions" "VS Code"
}

install_cursor() {
  local cli=""
  if ! cli="$(resolve_cursor_cli)"; then
    echo "[SKIP] Cursor CLI not found in PATH or /Applications/Cursor.app."
    return 2
  fi
  echo "Installing to Cursor..."
  install_to_editor "$cli" "${HOME}/.cursor/extensions" "Cursor"
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
    echo "  Note: if /usr/local/bin/code points at Cursor.app, this script uses the"
    echo "        Visual Studio Code.app bundle CLI instead."
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
