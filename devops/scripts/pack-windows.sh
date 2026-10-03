#!/bin/bash
# Packs pi-plus-desktop into a Windows x64 installation zip, cross-packed on
# macOS (this dev machine) — no Windows host, wine, or NSIS required.
#
# Usage:
#   devops/scripts/pack-windows.sh            # build + pack → release/Pi+-<version>-win-x64.zip
#   APP_NAME="Pi+ Desktop" devops/scripts/pack-windows.sh
#
# Output:
#   release/<AppName>-<version>-win-x64.zip   (extract anywhere, run pi-plus.exe)
#
# The zip is a portable install: it embeds the official Electron win32-x64
# distribution plus the app payload under resources/app/ (package.json, dist/,
# and a production node_modules tree resolved with --os=win32 --cpu=x64 so
# platform-specific optional deps, e.g. esbuild's binary, are the Windows ones).
#
# Production pack: dependencies must carry registry specs (see pack-macos.sh)
# — refuses to pack while package.json carries file: (symlinked) deps.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_NAME="${APP_NAME:-Pi+}"
EXE_NAME="pi-plus" # keep the executable plus-free for shell safety
VERSION="$(node -p "require('$ROOT/package.json').version")"
RELEASE_DIR="$ROOT/release"
STAGE="$ROOT/dist/pack-win"
CACHE_DIR="$ROOT/.pack-cache"

EV="$(cd "$ROOT" && node -p "require('electron/package.json').version")"
ELECTRON_ZIP="electron-v${EV}-win32-x64.zip"
ELECTRON_URL="https://github.com/electron/electron/releases/download/v${EV}/${ELECTRON_ZIP}"

cd "$ROOT"

echo "[pack-win] version $VERSION, app '$APP_NAME', electron $EV"

# 0. Symlink guard (fail fast before building anything): no file: deps allowed
#    in a distributable pack.
FILE_DEPS="$(node -p "const d=require('$ROOT/package.json').dependencies||{};Object.entries(d).filter(([,s])=>String(s).startsWith('file:')).map(([n])=>n).join(' ')")"
if [ -n "$FILE_DEPS" ]; then
	echo "[pack-win] refusing to pack: file: (symlinked) dependencies in package.json: $FILE_DEPS" >&2
	echo "[pack-win] production packs need registry specs, e.g.: npm install --save pi-plus-sdk@^0.1.4" >&2
	exit 1
fi

# 1. Production bundles (esbuild), copies assets into dist/. Same bundles the
#    macOS pack uses — the JS is platform-neutral.
echo "[pack-win] building renderer/main bundles…"
node scripts/build.mjs --production

# 2. Fetch the official Electron win32-x64 distribution (cached, checksum-
#    verified against the release's SHASUMS256.txt).
mkdir -p "$CACHE_DIR"
if [ -f "$CACHE_DIR/$ELECTRON_ZIP" ]; then
	echo "[pack-win] using cached $ELECTRON_ZIP"
else
	echo "[pack-win] downloading $ELECTRON_URL …"
	curl -fL --retry 3 --progress-bar -o "$CACHE_DIR/$ELECTRON_ZIP.part" "$ELECTRON_URL"
	curl -fL --retry 3 -s -o "$CACHE_DIR/electron-v${EV}-SHASUMS256.txt" \
		"https://github.com/electron/electron/releases/download/v${EV}/SHASUMS256.txt"
	# SHASUMS256.txt lines look like "<hash> *<file>" (BSD binary-mode format).
	(cd "$CACHE_DIR" && grep "\*${ELECTRON_ZIP}\$" "electron-v${EV}-SHASUMS256.txt" | shasum -a 256 -c -)
	mv "$CACHE_DIR/$ELECTRON_ZIP.part" "$CACHE_DIR/$ELECTRON_ZIP"
fi

# 3. Extract the distribution into the staging folder.
APP_DIR="$STAGE/$APP_NAME"
echo "[pack-win] assembling $APP_DIR …"
rm -rf "$STAGE"
mkdir -p "$APP_DIR"
ditto -x -k "$CACHE_DIR/$ELECTRON_ZIP" "$APP_DIR"
rm -f "$APP_DIR/resources/default_app.asar"
mv "$APP_DIR/electron.exe" "$APP_DIR/$EXE_NAME.exe"

# 4. App payload: package.json, dist/, and production-only node_modules
#    resolved for the Windows target (see header note on --os/--cpu).
APP_RES="$APP_DIR/resources/app"
mkdir -p "$APP_RES"
cp package.json package-lock.json "$APP_RES/"
cp -R dist "$APP_RES/dist"
rm -rf "$APP_RES/dist/pack" "$APP_RES/dist/pack-win" # don't nest pack staging inside the payload
# --ignore-scripts: install scripts execute at resolve time on THIS machine,
# and esbuild's postinstall spawns the target binary to validate it — impossible
# cross-platform. Its runtime finds the @esbuild/win32-x64 optional package
# directly, so skipping the scripts is safe (protobufjs/@google/genai scripts
# are notices only).
echo "[pack-win] installing production dependencies for win32-x64 (npm ci --omit=dev --os=win32 --cpu=x64 --ignore-scripts)…"
(
	cd "$APP_RES"
	npm ci --omit=dev --no-audit --no-fund --loglevel=error --ignore-scripts --os=win32 --cpu=x64
)
# Backstop for the step-0 guard: any symlinked package in the payload would
# dangle outside this zip.
LINKS="$(find "$APP_RES/node_modules" -maxdepth 1 -type l ! -name .bin | head -5)"
if [ -n "$LINKS" ]; then
	echo "[pack-win] refusing to pack: symlinked packages in the app payload:" >&2
	echo "$LINKS" | sed 's/^/[pack-win]   /' >&2
	echo "[pack-win] distributable packs need real copies in node_modules, not links." >&2
	exit 1
fi
# npm's --os filtering installs @esbuild/win32-x64 next to every nested esbuild
# but occasionally leaves a same-version darwin sibling behind. Non-win32
# binaries are never loaded on Windows, so drop them, then verify every esbuild
# copy resolves a win32-x64 binary of its own version (the packaged app would
# crash at first esbuild use otherwise).
find "$APP_RES/node_modules" -type d -path "*/@esbuild/*" ! -name "win32-x64" -prune -exec rm -rf {} +
node -e '
const fs = require("fs"), path = require("path");
const root = process.argv[1];
const bad = [];
(function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const p = path.join(dir, entry.name);
		if (entry.name === "esbuild" && fs.existsSync(path.join(p, "lib", "main.js"))) {
			const version = JSON.parse(fs.readFileSync(path.join(p, "package.json"))).version;
			let win;
			try { win = require.resolve("@esbuild/win32-x64/package.json", { paths: [p] }); }
			catch { bad.push("no win32-x64 binary for " + p); continue; }
			if (JSON.parse(fs.readFileSync(win)).version !== version)
				bad.push(`win32-x64 version mismatch for ${p} (esbuild ${version})`);
		}
		walk(p);
	}
})(path.join(root, "node_modules"));
if (bad.length) {
	console.error("[pack-win] refusing to pack:");
	for (const b of bad) console.error("[pack-win]   " + b);
	process.exit(1);
}
' "$APP_RES"

# 5. Zip the folder into release/. ditto keeps the parent directory name so
#    extracting produces a single "Pi+/" folder.
echo "[pack-win] creating zip…"
mkdir -p "$RELEASE_DIR"
ZIP="$RELEASE_DIR/$APP_NAME-$VERSION-win-x64.zip"
rm -f "$ZIP"
ditto -c -k --keepParent --norsrc --noextattr "$APP_DIR" "$ZIP"

# 6. Drop the staging folder so the zip is the only artifact.
rm -rf "$STAGE"

echo "[pack-win] done:"
echo "  $ZIP"
du -sh "$ZIP" | awk '{print "  size: " $1}'
