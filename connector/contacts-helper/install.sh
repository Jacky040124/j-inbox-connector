#!/bin/sh
# Optional: names instead of numbers for iMessage. Builds the helper into ~/Applications and runs it once, which asks
# for the Contacts permission on this Mac's screen. Needs Xcode's command line tools. Remove with:
#   rm -rf "$HOME/Applications/J-Inbox Contacts.app" "$HOME/Library/Application Support/j-inbox/contacts.json"
set -eu
cd "$(dirname "$0")"
APP="$HOME/Applications/J-Inbox Contacts.app"
OUT="$HOME/Library/Application Support/j-inbox/contacts.json"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$(dirname "$OUT")"
swiftc -O main.swift -o "$APP/Contents/MacOS/J-Inbox Contacts"
cp Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - --identifier build.jsuite.j-inbox.contacts "$APP"
open -a "$APP" --args "$OUT"
echo "Installed. If asked, allow Contacts. The connector picks the names up within a minute."
