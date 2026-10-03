#!/bin/bash
# Publishes pi-plus-desktop installation packs (macOS DMG + Windows zip) as a
# GitHub release, bumping the package version first and committing the bump
# after a successful publish.
#
# Usage:
#   devops/scripts/publish-github.sh                # bump patch (0.1.0 → 0.1.1) + publish
#   devops/scripts/publish-github.sh minor          # 0.1.0 → 0.2.0
#   devops/scripts/publish-github.sh keep           # publish the current version as-is;
#                                                   # also tolerates a dirty tree whose only
#                                                   # changes are an already-applied
#                                                   # `npm version` bump (version fields)
#   devops/scripts/publish-github.sh --dry-run      # pack both targets at the current
#                                                   # version; no bump, release, or commit
#   devops/scripts/publish-github.sh major --dry-run
#
# Flow (bump mode):
#   1. Guard: clean tree (or a version-only pre-bump with keep), gh
#      authenticated, no file: deps (dependencies must carry registry specs).
#   2. npm version <bump> --no-git-tag-version (working tree only; skipped
#      for keep).
#   3. pack-macos.sh + pack-windows.sh → release/Pi+-<version>.dmg and
#      release/Pi+-<version>-win-x64.zip.
#   4. gh release create v<version> with both artifacts + auto-generated notes.
#   5. Commit the package.json/package-lock.json version change and push (when
#      there is one); the v<version> tag (created by gh in step 4) sits on the
#      pre-bump commit.
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
		keep | patch | minor | major | premajor | preminor | prepatch | prerelease) BUMP="$arg" ;;
		-h | --help)
			sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "[publish] unknown argument: $arg (expected keep|patch|minor|major|… or --dry-run)" >&2
			exit 1
			;;
	esac
done

VERSION="$(node -p "require('$ROOT/package.json').version")"

# Succeeds when the only working-tree changes are package.json and/or
# package-lock.json and their diffs are strictly version fields — the exact
# output of `npm version <x> --no-git-tag-version` — with the version actually
# differing from HEAD. Lets `keep` publish a pre-applied bump without first
# committing an unrelated-looking "version" commit.
is_version_only_bump() {
	node -e '
		const cp = require("child_process");
		const fs = require("fs");
		const sh = (cmd) => cp.execSync(cmd, { encoding: "utf8" });
		const changed = [...new Set(
			(sh("git diff --name-only") + "\n" + sh("git ls-files --others --exclude-standard"))
				.split("\n").map((f) => f.trim()).filter(Boolean),
		)];
		const fail = () => process.exit(1);
		if (changed.length === 0) fail();
		if (!changed.every((f) => f === "package.json" || f === "package-lock.json")) fail();
		if (!changed.includes("package.json")) fail();
		const headPkg = JSON.parse(sh("git show HEAD:package.json"));
		const workPkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
		if (headPkg.version === workPkg.version) fail();
		headPkg.version = null; workPkg.version = null;
		if (JSON.stringify(headPkg) !== JSON.stringify(workPkg)) fail();
		if (changed.includes("package-lock.json")) {
			const strip = (src) => {
				const o = JSON.parse(src);
				o.version = null;
				if (o.packages && o.packages[""]) o.packages[""].version = null;
				return JSON.stringify(o);
			};
			if (strip(sh("git show HEAD:package-lock.json")) !== strip(fs.readFileSync("package-lock.json", "utf8"))) fail();
		}
	' >/dev/null 2>&1
}

# --- guards (both modes) ----------------------------------------------------
FILE_DEPS="$(node -p "const d=require('$ROOT/package.json').dependencies||{};Object.entries(d).filter(([,s])=>String(s).startsWith('file:')).map(([n])=>n).join(' ')")"
if [ -n "$FILE_DEPS" ]; then
	echo "[publish] refusing to publish: file: (symlinked) dependencies in package.json: $FILE_DEPS" >&2
	echo "[publish] production publishes need registry specs, e.g.: npm install --save pi-plus-sdk@^0.1.4" >&2
	exit 1
fi

if [ "$DRY_RUN" -eq 0 ]; then
	if [ -n "$(git status --porcelain)" ]; then
		# A dirty tree is refused, except with `keep` when the dirt is only an
		# already-applied version bump — the release commit below carries it.
		if [ "$BUMP" = "keep" ] && is_version_only_bump; then
			echo "[publish] publishing pre-bumped working version $VERSION (only version fields differ from HEAD)"
		else
			echo "[publish] refusing to publish: working tree is not clean:" >&2
			git status --porcelain | sed 's/^/[publish]   /' >&2
			echo "[publish] commit or stash the changes first, or use 'keep' to publish an already-applied version bump." >&2
			exit 1
		fi
	fi
	if ! gh auth status >/dev/null 2>&1; then
		echo "[publish] gh is not authenticated for github.com; run: gh auth login" >&2
		exit 1
	fi
fi

# --- pack -------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
	echo "[publish] dry-run: packing at current version $VERSION (no bump, no release, no commit)"
elif [ "$BUMP" = "keep" ]; then
	echo "[publish] publishing v$VERSION as-is (no bump)"
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
git add package.json package-lock.json
if git diff --cached --quiet; then
	echo "[publish] version files already committed at $VERSION; nothing to commit"
else
	echo "[publish] committing version bump…"
	git commit -m "Release v$VERSION"
	git push origin HEAD
fi
git fetch --tags --quiet

echo "[publish] done:"
gh release view "v$VERSION" --json url,assets --jq '.url as $u | ($u, (.assets[].name | "  " + .))'
