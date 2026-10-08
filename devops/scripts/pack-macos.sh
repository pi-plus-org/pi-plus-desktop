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
# Production pack: dependencies must carry registry specs. file: deps (a
# locally linked pi-plus-sdk) install as symlinks pointing at dev-machine paths,
# which break on any other machine — this script refuses to pack while they are
# in package.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_NAME="${APP_NAME:-Pi+}"
EXE_NAME="pi-plus" # keep the executable plus-free for shell safety
BUNDLE_ID="works.earendil.pi-plus-desktop"
VERSION="$(node -p "require('$ROOT/package.json').version")"
RELEASE_DIR="$ROOT/release"
STAGE="$ROOT/dist/pack"

cd "$ROOT"

echo "[pack] version $VERSION, app '$APP_NAME'"

# 0. Symlink guard (fail fast before building anything): no file: deps allowed
#    in a distributable pack.
FILE_DEPS="$(node -p "const d=require('$ROOT/package.json').dependencies||{};Object.entries(d).filter(([,s])=>String(s).startsWith('file:')).map(([n])=>n).join(' ')")"
if [ -n "$FILE_DEPS" ]; then
	echo "[pack] refusing to pack: file: (symlinked) dependencies in package.json: $FILE_DEPS" >&2
	echo "[pack] production packs need registry specs, e.g.: npm install --save pi-plus-sdk@^0.1.4" >&2
	exit 1
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
# Backstop for the step-0 guard: any symlinked package in the payload (not just
# file: specs — links introduced by npm itself) would dangle outside this DMG.
LINKS="$(find "$APP_RES/node_modules" -maxdepth 1 -type l ! -name .bin | head -5)"
if [ -n "$LINKS" ]; then
	echo "[pack] refusing to pack: symlinked packages in the app payload:" >&2
	echo "$LINKS" | sed 's/^/[pack]   /' >&2
	echo "[pack] distributable packs need real copies in node_modules, not links." >&2
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
