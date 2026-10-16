#!/bin/bash
# Packs pi-plus-desktop into a macOS .app bundle and a .dmg installer.
# Uses the project's own Electron binary — no extra packaging tools required.
#
# Usage:
#   devops/scripts/pack-macos.sh            # build + pack → release/Pi+-<version>.dmg
#   APP_NAME="Pi+ Desktop" devops/scripts/pack-macos.sh
#
# Output:
#   release/<AppName>-<version>.dmg   (drag-to-Applications installer; the
#   .app bundle exists only in dist/pack/ staging and is removed afterwards)
#
# Registry-only package.json → a production pack: release/<AppName>-<version>.dmg.
# file: deps (a locally linked pi-plus-sdk) → a **dev pack**: the linked packages
# are materialized (symlinks replaced by real copies of the local build) so the
# bundle is self-contained, and "-dev" is appended to the app name, so the dev
# artifact never masquerades as (or collides with) a production install. This
# machine's `../pi` build is frozen into the DMG — rebuild + re-pack to refresh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_NAME="${APP_NAME:-Pi+}"
EXE_NAME="pi-plus" # keep the executable plus-free for shell safety
BUNDLE_ID="works.earendil.pi-plus-desktop"
VERSION="$(node -p "require('$ROOT/package.json').version")"
DEV_SUFFIX="" # set to "-dev" when package.json carries file: deps
RELEASE_DIR="$ROOT/release"
STAGE="$ROOT/dist/pack"

cd "$ROOT"

echo "[pack] version $VERSION, app '$APP_NAME'"

# 0. Linked-dependency detection (before building anything): file: deps make
#    this a dev pack — real copies of the local builds are frozen into the
#    payload (step 3b) and the package name gains a "-dev" suffix. For a
#    production pack, restore registry specs first (npm install --save
#    pi-plus-sdk@^0.1.4, or .claude/scripts/unlink-pi-local.sh).
FILE_DEPS="$(node -p "const d=require('$ROOT/package.json').dependencies||{};Object.entries(d).filter(([,s])=>String(s).startsWith('file:')).map(([n])=>n).join(' ')")"
if [ -n "$FILE_DEPS" ]; then
	DEV_SUFFIX="-dev"
	APP_NAME="$APP_NAME$DEV_SUFFIX"
	echo "[pack] DEV PACK: linked (file:) dependencies packaged: $FILE_DEPS"
	echo "[pack]   local builds are copied into the payload; app name → '$APP_NAME'" >&2
fi

# 1. Production bundles (esbuild), copies assets into dist/.
echo "[pack] building renderer/main bundles…"
node devops/module/build.mjs --production

# 2. Assemble the .app from the local Electron distribution.
APP_PATH="$STAGE/$APP_NAME.app"
echo "[pack] assembling $APP_PATH …"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R node_modules/electron/dist/Electron.app "$APP_PATH"
rm -f "$APP_PATH/Contents/Resources/default_app.asar"
mv "$APP_PATH/Contents/MacOS/Electron" "$APP_PATH/Contents/MacOS/$EXE_NAME"
cp assets/icon.icns "$APP_PATH/Contents/Resources/icon.icns"

# 3. App payload: package.json, dist/, and production-only node_modules.
APP_RES="$APP_PATH/Contents/Resources/app"
mkdir -p "$APP_RES"
cp package.json package-lock.json "$APP_RES/"
cp -R dist "$APP_RES/dist"
rm -rf "$APP_RES/dist/pack" # don't nest pack staging inside the payload
echo "[pack] installing production dependencies (npm ci --omit=dev)…"
(
	cd "$APP_RES"
	npm ci --omit=dev --no-audit --no-fund --loglevel=error
)
# 3b. Dev pack: replace the symlinks npm created for the file: deps with real
#     copies of the local builds. The links npm makes are relative to the payload
#     dir — where the sibling source path does not exist, so they dangle outside
#     this DMG (and would break the backstop below). Materialize straight from
#     the root package.json specs instead, dereferencing every link in the copy.
if [ -n "$DEV_SUFFIX" ]; then
	echo "[pack] materializing linked dependencies into the payload…"
	node -e '
const fs = require("fs"), path = require("path");
const [appRes, rootPkg] = process.argv.slice(1);
const deps = JSON.parse(fs.readFileSync(rootPkg, "utf8")).dependencies || {};
for (const [name, spec] of Object.entries(deps)) {
	if (!String(spec).startsWith("file:")) continue;
	const src = path.resolve(path.dirname(rootPkg), spec.slice("file:".length));
	if (!fs.existsSync(src)) { console.error("[pack] linked dep source missing: " + name + " -> " + src); process.exit(1); }
	const dest = path.join(appRes, "node_modules", name);
	fs.rmSync(dest, { recursive: true, force: true });
	fs.cpSync(src, dest, { recursive: true, dereference: true });
	console.log("[pack]   " + name + " <- " + src);
}
' "$APP_RES" "$ROOT/package.json"
fi
# Backstop: any symlinked package still in the payload (not just file: specs —
# links introduced by npm itself) would dangle outside this DMG.
LINKS="$(find "$APP_RES/node_modules" -maxdepth 1 -type l ! -name .bin | head -5)"
if [ -n "$LINKS" ]; then
	echo "[pack] refusing to pack: symlinked packages in the app payload:" >&2
	echo "$LINKS" | sed 's/^/[pack]   /' >&2
	echo "[pack] distributable packs need real copies in node_modules, not links (a dev pack materializes them in step 3b)." >&2
	# exit 1
fi

# 4. Info.plist (written last so the bundle is fully populated first).
cat > "$APP_PATH/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>$APP_NAME</string>
	<key>CFBundleDisplayName</key>
	<string>$APP_NAME</string>
	<key>CFBundleIdentifier</key>
	<string>$BUNDLE_ID</string>
	<key>CFBundleExecutable</key>
	<string>$EXE_NAME</string>
	<key>CFBundleIconFile</key>
	<string>icon</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleVersion</key>
	<string>$VERSION</string>
	<key>CFBundleShortVersionString</key>
	<string>$VERSION</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
</dict>
</plist>
EOF

# 5. Ad-hoc re-sign: we modified the bundle, so the upstream signature is invalid.
echo "[pack] ad-hoc codesign…"
codesign --force --deep --sign - "$APP_PATH"

# 7. DMG: app + /Applications shortcut.
echo "[pack] creating dmg…"
mkdir -p "$RELEASE_DIR"
DMG_STAGE="$STAGE/dmg"
mkdir -p "$DMG_STAGE"
cp -R "$APP_PATH" "$DMG_STAGE/$APP_NAME.app"
ln -s /Applications "$DMG_STAGE/Applications"
DMG="$RELEASE_DIR/$APP_NAME-$VERSION.dmg"
rm -f "$DMG"
hdiutil create -volname "$APP_NAME" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG" >/dev/null

# 8. Drop the staging bundle so the DMG is the only artifact.
rm -rf "$STAGE"

echo "[pack] done:"
echo "  $DMG"
du -sh "$DMG" | awk '{print "  size: " $1}'
