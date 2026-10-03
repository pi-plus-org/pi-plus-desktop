#!/bin/bash
# Publishes pi-plus-desktop installation packs (macOS DMG + Windows zip) as a
# GitHub release, bumping the package version first and committing the bump
# after a successful publish.
#
# Usage:
#   devops/scripts/publish-github.sh                # bump patch (0.1.0 → 0.1.1) + publish
#   devops/scripts/publish-github.sh minor          # 0.1.0 → 0.2.0
#   devops/scripts/publish-github.sh --dry-run      # pack both targets at the current
#                                                   # version; no bump, release, or commit
#   devops/scripts/publish-github.sh major --dry-run
#
# Flow (bump mode):
#   1. Guard: clean tree, gh authenticated, no file: deps (dependencies must
#      carry registry specs, not local file: links).
#   2. npm version <bump> --no-git-tag-version (working tree only).
#   3. pack-macos.sh + pack-windows.sh → release/Pi+-<version>.dmg and
#      release/Pi+-<version>-win-x64.zip.
#   4. gh release create v<version> with both artifacts + auto-generated notes.
#   5. Commit the package.json/package-lock.json version change and push; the
#      v<version> tag (created by gh in step 4) sits on the pre-bump commit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_NAME="${APP_NAME:-Pi+}"
RELEASE_DIR="$ROOT/release"

cd "$ROOT"

# --- args -------------------------------------------------------------------
BUMP="patch"
DRY_RUN=0
for arg in "$@"; do
	case "$arg" in
		--dry-run) DRY_RUN=1 ;;
		patch | minor | major | premajor | preminor | prepatch | prerelease) BUMP="$arg" ;;
		-h | --help)
			sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "[publish] unknown argument: $arg (expected patch|minor|major|… or --dry-run)" >&2
			exit 1
			;;
	esac
done

VERSION="$(node -p "require('$ROOT/package.json').version")"

# --- guards (both modes) ----------------------------------------------------
FILE_DEPS="$(node -p "const d=require('$ROOT/package.json').dependencies||{};Object.entries(d).filter(([,s])=>String(s).startsWith('file:')).map(([n])=>n).join(' ')")"
if [ -n "$FILE_DEPS" ]; then
	echo "[publish] refusing to publish: file: (symlinked) dependencies in package.json: $FILE_DEPS" >&2
	echo "[publish] production publishes need registry specs, e.g.: npm install --save pi-plus-sdk@^0.1.4" >&2
	exit 1
fi

if [ "$DRY_RUN" -eq 0 ]; then
	if [ -n "$(git status --porcelain)" ]; then
		echo "[publish] refusing to publish: working tree is not clean:" >&2
		git status --porcelain | sed 's/^/[publish]   /' >&2
		echo "[publish] commit or stash the changes first." >&2
		exit 1
	fi
	if ! gh auth status >/dev/null 2>&1; then
		echo "[publish] gh is not authenticated for github.com; run: gh auth login" >&2
		exit 1
	fi
fi

# --- pack -------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
	echo "[publish] dry-run: packing at current version $VERSION (no bump, no release, no commit)"
else
	echo "[publish] bumping version ($BUMP)…"
	VERSION="$(npm version "$BUMP" --no-git-tag-version | tr -d '\r\n=' | sed 's/^v//')"
	echo "[publish] publishing v$VERSION"
fi

bash devops/scripts/pack-macos.sh
bash devops/scripts/pack-windows.sh

DMG="$RELEASE_DIR/$APP_NAME-$VERSION.dmg"
ZIP="$RELEASE_DIR/$APP_NAME-$VERSION-win-x64.zip"
for artifact in "$DMG" "$ZIP"; do
	[ -f "$artifact" ] || { echo "[publish] expected artifact missing: $artifact" >&2; exit 1; }
done

if [ "$DRY_RUN" -eq 1 ]; then
	echo "[publish] dry-run done; artifacts:"
	echo "  $DMG"
	echo "  $ZIP"
	echo "[publish] (working tree left with build outputs only — nothing published or committed)"
	exit 0
fi

# --- release ----------------------------------------------------------------
echo "[publish] creating GitHub release v$VERSION…"
gh release create "v$VERSION" "$DMG" "$ZIP" \
	--title "$APP_NAME $VERSION" \
	--generate-notes \
	--target "$(git rev-parse HEAD)"

# --- post-publish commit ----------------------------------------------------
echo "[publish] committing version bump…"
git add package.json package-lock.json
git commit -m "Release v$VERSION"
git push origin HEAD
git fetch --tags --quiet

echo "[publish] done:"
gh release view "v$VERSION" --json url,assets --jq '.url as $u | ($u, (.assets[].name | "  " + .))'
