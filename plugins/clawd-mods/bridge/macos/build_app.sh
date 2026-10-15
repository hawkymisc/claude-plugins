#!/bin/bash
# ClawdBridge.app を組み立てて ad-hoc 署名する。
# usage: macos/build_app.sh [out_dir]   (default: ~/Applications)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HOME/Applications}"
APP="$OUT/ClawdBridge.app"
mkdir -p "$APP/Contents/MacOS"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
# Info.plist をバイナリにも埋め込む (launchd が直接起動しても TCC が読めるように)
cc -O2 -Wall -Wextra -o "$APP/Contents/MacOS/ClawdBridge" "$HERE/launcher.c" \
  -sectcreate __TEXT __info_plist "$HERE/Info.plist"
codesign --force --sign - --identifier dev.clawd.bridge "$APP"
codesign --verify --verbose=2 "$APP"
echo "built: $APP"
