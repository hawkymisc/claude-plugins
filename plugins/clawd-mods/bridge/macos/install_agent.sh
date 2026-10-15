#!/bin/bash
# ClawdBridge.app をビルドし、LaunchAgent としてログイン時常駐させる。
# usage: macos/install_agent.sh            インストール / 更新
#        macos/install_agent.sh uninstall  停止して plist を削除 (.app は残す)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$(cd "$HERE/.." && pwd)"
LABEL="dev.clawd.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="$HOME/Applications/ClawdBridge.app"
LOG="$HOME/.clawd-bridge/bridge.log"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || echo "not loaded: $LABEL"
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

(cd "$BRIDGE" && uv sync --no-dev)
"$HERE/build_app.sh" "$HOME/Applications"
mkdir -p -m 700 "$HOME/.clawd-bridge"; mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP/Contents/MacOS/ClawdBridge</string>
    <string>$BRIDGE/.venv/bin/python</string>
    <string>-m</string>
    <string>clawd_bridge.main</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$HOME/.clawd-bridge/launchd.out</string>
  <key>StandardErrorPath</key><string>$HOME/.clawd-bridge/launchd.out</string>
</dict>
</plist>
PL
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL; log: $LOG"
