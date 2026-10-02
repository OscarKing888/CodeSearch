#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ $# -lt 1 ]]; then
  echo "Usage:"
  echo "  ./bump-version.sh 0.2.1 --notes \"Fix Electron ABI 146 native packaging.\""
  echo
  echo "Updates the version files, commits them, creates an annotated version tag, and pushes"
  echo "main together with the tag to origin by default (run from a checkout on main)."
  echo "Use --no-tag to skip the tag, --no-push to keep the commit and tag local,"
  echo "or --no-commit to only update files."
  exit 1
fi

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "node not found. Please install Node.js."

# scripts/bump-version.js validates and updates the version files, then prints a key=value plan.
# The commit, tag, and push below are plain git commands.
plan="$(CODESEARCH_BUMP_ENTRY=1 node scripts/bump-version.js "$@")"
version='' commit=0 create_tag=0 push=0 push_tag=0
while IFS= read -r line; do
  value="${line#*=}"
  case "${line%%=*}" in
    version) version="$value" ;;
    commit) commit="$value" ;;
    create_tag) create_tag="$value" ;;
    push) push="$value" ;;
    push_tag) push_tag="$value" ;;
  esac
done <<<"$plan"
[[ -n "$version" ]] || fail "scripts/bump-version.js returned an incomplete plan."
tag="v$version"

if [[ "$commit" == 1 ]]; then
  # --only commits these working-tree paths without including other staged work.
  git commit --only -m "chore: bump version to $version" -- package.json package-lock.json CHANGELOG.md ||
    fail "Version files were updated, but the commit failed. Changes were kept. After fixing the Git error, commit only package.json, package-lock.json, and CHANGELOG.md."
fi

if [[ "$create_tag" == 1 ]]; then
  head="$(git rev-parse HEAD)"
  git tag -a "$tag" "$head" -m "Release $version" ||
    fail "Version commit $head was kept, but creating tag $tag failed. Fix the Git error and rerun the same version to create the missing tag. Existing tags are never overwritten."
  echo "Created annotated tag $tag at $head."
fi

if [[ "$push" == 1 ]]; then
  refs=(refs/heads/main:refs/heads/main)
  [[ "$push_tag" == 1 ]] && refs+=("refs/tags/$tag:refs/tags/$tag")
  # --atomic: origin gets main and the tag together, or neither.
  git push --atomic origin "${refs[@]}" ||
    fail "The local version commit and tag were kept, but pushing to origin failed. Fix the Git error (for example, merge origin/main into main), then rerun: ./bump-version.sh $version"
  if [[ "$push_tag" == 1 ]]; then echo "Pushed main and $tag to origin."; else echo "Pushed main to origin."; fi
fi
