#!/bin/sh
# Builds J-Inbox's sign-in window (signin-helper/) as "J-Inbox Sign-in.app" in the directory given,
# ad-hoc signed like the connector itself. Used by scripts/release-connector.sh (the release ships it
# as j-inbox-signin-darwin-arm64.tar.gz, which install.sh puts in ~/Applications) and by tests.
# Needs Xcode's command line tools (swiftc, codesign). Builds nothing else and installs nothing.
#   connector/signin-helper/build.sh <out dir>
set -eu
[ $# -eq 1 ] || { echo "usage: build.sh <out dir>" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$1"
out=$(cd "$1" && pwd)
app="$out/J-Inbox Sign-in.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
swiftc -O -target arm64-apple-macos13.0 "$here/main.swift" -framework WebKit -framework AppKit -o "$app/Contents/MacOS/J-Inbox Sign-in"
cp "$here/Info.plist" "$app/Contents/Info.plist"
codesign --force --sign - --identifier build.jsuite.j-inbox.signin "$app" >/dev/null 2>&1
codesign -v --strict "$app"
echo "$app"
