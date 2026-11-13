#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RESOURCE_DIR="$ROOT_DIR/macos/resources"
EXPECTED_VERSION="v26.10.0"
DMG_OUT=""
STAGE_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dmg)
      [[ $# -ge 2 ]] || { echo "Missing DMG output path" >&2; exit 2; }
      DMG_OUT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

[[ "$(uname -m)" == "arm64" ]] || { echo "Build requires an Apple Silicon Mac" >&2; exit 1; }
[[ -d "$ROOT_DIR/.next/standalone" ]] || { echo "Missing .next/standalone. Run bun run build first." >&2; exit 1; }
[[ -f "$RESOURCE_DIR/launch-local.cjs" ]] || { echo "Missing bundled launcher resource" >&2; exit 1; }

NODE_BIN="${OPENMINDMAP_NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "Set OPENMINDMAP_NODE_BIN to Node.js $EXPECTED_VERSION arm64" >&2; exit 1; }
NODE_VERSION="$("$NODE_BIN" -p 'process.version')"
NODE_ARCH="$("$NODE_BIN" -p 'process.arch')"
[[ "$NODE_VERSION" == "$EXPECTED_VERSION" ]] || { echo "Expected Node $EXPECTED_VERSION, found $NODE_VERSION" >&2; exit 1; }
[[ "$NODE_ARCH" == "arm64" ]] || { echo "Expected arm64 Node runtime, found $NODE_ARCH" >&2; exit 1; }

(
  cd "$RESOURCE_DIR"
  shasum -a 256 -c SHA256SUMS
)

for resource in AppIcon.icns Assets.car Node-LICENSE.txt launch-local.cjs; do
  [[ -f "$RESOURCE_DIR/$resource" ]] || { echo "Missing resource: $resource" >&2; exit 1; }
done

if [[ -n "$DMG_OUT" ]]; then
  case "$DMG_OUT" in
    /*) ;;
    *) DMG_OUT="$ROOT_DIR/$DMG_OUT" ;;
  esac
  [[ ! -e "$DMG_OUT" ]] || { echo "Refusing to overwrite existing file: $DMG_OUT" >&2; exit 1; }
  [[ ! -e "$DMG_OUT.sha256" ]] || { echo "Refusing to overwrite existing checksum: $DMG_OUT.sha256" >&2; exit 1; }
  mkdir -p "$(dirname "$DMG_OUT")"
fi

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openmindmap-package.XXXXXX")"
cleanup() {
  if [[ -n "$STAGE_DIR" ]]; then
    rm -rf "$STAGE_DIR"
  fi
}
trap cleanup EXIT

APP_PATH="$STAGE_DIR/OpenMindmap.app"
mkdir -p \
  "$APP_PATH/Contents/MacOS" \
  "$APP_PATH/Contents/Helpers" \
  "$APP_PATH/Contents/Resources/web"

cp "$ROOT_DIR/macos/Info.plist" "$APP_PATH/Contents/Info.plist"
cp "$RESOURCE_DIR/AppIcon.icns" "$APP_PATH/Contents/Resources/AppIcon.icns"
cp "$RESOURCE_DIR/Assets.car" "$APP_PATH/Contents/Resources/Assets.car"
cp "$RESOURCE_DIR/Node-LICENSE.txt" "$APP_PATH/Contents/Resources/Node-LICENSE.txt"
cp "$NODE_BIN" "$APP_PATH/Contents/Helpers/node"
chmod 755 "$APP_PATH/Contents/Helpers/node"

cp "$RESOURCE_DIR/launch-local.cjs" "$APP_PATH/Contents/Resources/web/launch-local.cjs"
cp -R "$ROOT_DIR/.next/standalone/." "$APP_PATH/Contents/Resources/web/"
if [[ -d "$ROOT_DIR/public" ]]; then
  mkdir -p "$APP_PATH/Contents/Resources/web/public"
  cp -R "$ROOT_DIR/public/." "$APP_PATH/Contents/Resources/web/public/"
fi
if [[ -d "$ROOT_DIR/.next/static" ]]; then
  mkdir -p "$APP_PATH/Contents/Resources/web/.next/static"
  cp -R "$ROOT_DIR/.next/static/." "$APP_PATH/Contents/Resources/web/.next/static/"
fi

rm -rf \
  "$APP_PATH/Contents/Resources/web/macos" \
  "$APP_PATH/Contents/Resources/web/tests" \
  "$APP_PATH/Contents/Resources/web/scripts" \
  "$APP_PATH/Contents/Resources/web/dist" \
  "$APP_PATH/Contents/Resources/web/.git"

swiftc -O -target arm64-apple-macos13.5 -framework AppKit -framework WebKit \
  -module-cache-path "$STAGE_DIR/swift-module-cache" \
  "$ROOT_DIR/macos/WorkspaceTransferStore.swift" \
  "$ROOT_DIR/macos/MenuBuilder.swift" \
  "$ROOT_DIR/macos/OpenMindmapApp.swift" \
  -o "$APP_PATH/Contents/MacOS/OpenMindmap"

chmod 755 "$APP_PATH/Contents/MacOS/OpenMindmap"
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"

if [[ -n "$DMG_OUT" ]]; then
  DMG_STAGE="$STAGE_DIR/dmg-root"
  mkdir -p "$DMG_STAGE"
  cp -R "$APP_PATH" "$DMG_STAGE/OpenMindmap.app"
  ln -s /Applications "$DMG_STAGE/Applications"
  hdiutil create -volname "OpenMindmap" -srcfolder "$DMG_STAGE" -format UDZO "$DMG_OUT" >/dev/null
  hdiutil verify "$DMG_OUT" >/dev/null
  shasum -a 256 "$DMG_OUT" > "$DMG_OUT.sha256"
  echo "BUILT: $DMG_OUT"
  echo "CHECKSUM: $DMG_OUT.sha256"
else
  echo "BUILT: $APP_PATH"
  echo "Set --dmg <output path> to package a DMG."
fi
