#!/bin/sh
# J-Inbox connector installer, for a Mac with Apple silicon.
# SPDX-License-Identifier: MIT (see LICENSE in https://github.com/Jacky040124/j-inbox-connector)
#
#   curl -fsSL https://inbox.jackyzhonghq.com/install.sh | sh
#   curl -fsSL https://inbox.jackyzhonghq.com/install.sh | sh -s -- --name "Studio Mac"
#
# What it does: downloads `j-inbox-darwin-arm64` and `j-inbox-darwin-arm64.sha256` from the latest
# release of github.com/Jacky040124/j-inbox-connector, checks the SHA-256, puts the binary at
# ~/.local/bin/j-inbox (no sudo), then runs `j-inbox setup` in your terminal. Arguments after
# `sh -s --` go to `j-inbox setup`. Run it again to upgrade: the binary is replaced by a rename (a
# running service keeps its old file) and setup reinstalls the background service on the new one.
# It also installs J-Inbox's sign-in window, ~/Applications/J-Inbox Sign-in.app
# (`j-inbox-signin-darwin-arm64.tar.gz` and its .sha256, checked the same way): the small app the
# connector opens on this Mac when a chat app only allows signing in on its own website (Instagram).
# A release without it installs the binary and says so.
#
# Environment:
#   J_INBOX_DOWNLOAD_URL  where the two files are (default: the latest GitHub release). https only;
#                         http only for http://127.0.0.1 or http://localhost (tests).
#   J_INBOX_NO_SETUP=1    install or upgrade the binary only; do not run `j-inbox setup`.
#
# Gatekeeper: curl does not set the com.apple.quarantine attribute (only apps that opt in, such as
# browsers, do), so macOS runs the ad-hoc signed binary without a prompt. A quarantined copy (for
# example one saved by Safari) is blocked by Gatekeeper and never starts, and the block sticks to that
# file. To be safe the attribute is removed from the new file before it first runs. Rosetta: a terminal running under
# Rosetta still gets the arm64 binary, which runs natively.
#
# The whole script is inside main(), called on the last line, so a cut-off download runs nothing.
set -eu

REPO_URL="https://github.com/Jacky040124/j-inbox-connector/releases/latest/download"
ASSET="j-inbox-darwin-arm64"
SIGNIN_ASSET="j-inbox-signin-darwin-arm64.tar.gz"
SIGNIN_APP="J-Inbox Sign-in.app"
INSTALL_CMD="curl -fsSL https://inbox.jackyzhonghq.com/install.sh | sh"

say() { printf '%s\n' "$*"; }
die() {
  printf 'j-inbox install: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "${staged:-}" ]; then rm -f "$staged"; fi
  if [ -n "${staged_app:-}" ]; then rm -rf "$staged_app"; fi
  if [ -n "${tmp:-}" ]; then rm -rf "$tmp"; fi
}

# check_sum FILE NAME: the .sha256 next to FILE is one `shasum -a 256` line naming NAME, and matches.
check_sum() {
  expected=""
  name=""
  read -r expected name <"$1.sha256" || true
  case $name in "$2" | "*$2") ;; *) die "The checksum file does not name $2." ;; esac
  case $expected in *[!0-9a-f]*) die "The checksum file is not a SHA-256." ;; esac
  [ ${#expected} -eq 64 ] || die "The checksum file is not a SHA-256."
  actual=$(shasum -a 256 <"$1" | awk '{print $1}')
  if [ "$actual" != "$expected" ]; then
    die "Checksum mismatch for $2 (expected $expected, got $actual). Nothing was installed."
  fi
}

# fetch URL FILE
fetch() {
  if [ "$secure" = 1 ]; then
    curl -fsSL --retry 2 --proto '=https' --proto-redir '=https' --tlsv1.2 -o "$2" "$1" </dev/null
  else
    curl -fsSL --retry 2 -o "$2" "$1" </dev/null
  fi
}

check_platform() {
  os=$(uname -s)
  arch=$(uname -m)
  if [ "$os" != Darwin ]; then
    die "J-Inbox's connector needs a Mac with Apple silicon (this computer runs $os)."
  fi
  if [ "$arch" = arm64 ]; then return 0; fi
  # An x86_64 shell on Apple silicon (Rosetta) says x86_64; the arm64 binary still runs natively.
  if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    say "This terminal runs under Rosetta; installing the Apple silicon build (it runs natively)."
    return 0
  fi
  die "J-Inbox's connector needs a Mac with Apple silicon (this Mac is $arch)."
}

main() {
  check_platform
  for t in curl shasum mktemp; do
    command -v "$t" >/dev/null 2>&1 || die "$t is missing; it comes with macOS."
  done
  if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then die "HOME is not set to a directory."; fi

  base=${J_INBOX_DOWNLOAD_URL:-$REPO_URL}
  base=${base%/}
  case $base in
    https://*) secure=1 ;;
    http://127.0.0.1:* | http://127.0.0.1/* | http://localhost:* | http://localhost/*) secure=0 ;;
    *) die "J_INBOX_DOWNLOAD_URL must start with https:// (http only for 127.0.0.1 or localhost)." ;;
  esac

  staged=""
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/j-inbox-install.XXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP

  say "Downloading the J-Inbox connector from $base"
  fetch "$base/$ASSET" "$tmp/$ASSET" || die "Could not download $base/$ASSET."
  fetch "$base/$ASSET.sha256" "$tmp/$ASSET.sha256" || die "Could not download $base/$ASSET.sha256."

  # The .sha256 file is one `shasum -a 256` line: <64 hex>  j-inbox-darwin-arm64
  check_sum "$tmp/$ASSET" "$ASSET"
  say "Checksum ok."

  # The sign-in window: checked before anything is installed, like the binary. An older release has none.
  signin=0
  if fetch "$base/$SIGNIN_ASSET" "$tmp/$SIGNIN_ASSET" 2>/dev/null; then
    fetch "$base/$SIGNIN_ASSET.sha256" "$tmp/$SIGNIN_ASSET.sha256" || die "Could not download $base/$SIGNIN_ASSET.sha256."
    check_sum "$tmp/$SIGNIN_ASSET" "$SIGNIN_ASSET"
    mkdir "$tmp/signin"
    tar -xzf "$tmp/$SIGNIN_ASSET" -C "$tmp/signin" || die "Could not unpack $SIGNIN_ASSET. Nothing was installed."
    [ -x "$tmp/signin/$SIGNIN_APP/Contents/MacOS/J-Inbox Sign-in" ] || die "$SIGNIN_ASSET has no $SIGNIN_APP. Nothing was installed."
    signin=1
  fi

  dir="$HOME/.local/bin"
  bin="$dir/j-inbox"
  mkdir -p "$dir" || die "Could not create $dir."
  old=""
  if [ -x "$bin" ]; then old=$("$bin" --version </dev/null 2>/dev/null || true); fi

  # Stage a new file in the same directory, then rename it over the old one. A rename is atomic and
  # gives a new inode: a running service keeps its old file. Copying over a running binary instead
  # gets it killed (Killed: 9) by the code signing cache.
  staged="$dir/.j-inbox.new.$$"
  cp "$tmp/$ASSET" "$staged" || die "Could not write to $dir."
  chmod 755 "$staged"
  xattr -d com.apple.quarantine "$staged" >/dev/null 2>&1 || true
  version=$("$staged" --version </dev/null 2>/dev/null) || die "The downloaded j-inbox does not start. Nothing was changed."
  mv -f "$staged" "$bin" || die "Could not move the new j-inbox into $dir."
  staged=""
  if [ -n "$old" ] && [ "$old" != "$version" ]; then
    say "Upgraded j-inbox $old -> $version at $bin"
  elif [ -n "$old" ]; then
    say "Reinstalled j-inbox $version at $bin"
  else
    say "Installed j-inbox $version at $bin"
  fi

  if [ "$signin" = 1 ]; then
    # Next to the old one, then swapped by rename, so a half-copied app never stands in its place.
    apps="$HOME/Applications"
    mkdir -p "$apps" || die "Could not create $apps."
    staged_app="$apps/.j-inbox-signin.new.$$"
    rm -rf "$staged_app"
    mv "$tmp/signin/$SIGNIN_APP" "$staged_app" || die "Could not write to $apps."
    xattr -dr com.apple.quarantine "$staged_app" >/dev/null 2>&1 || true
    rm -rf "$apps/$SIGNIN_APP"
    mv "$staged_app" "$apps/$SIGNIN_APP" || die "Could not move the sign-in window into $apps."
    staged_app=""
    say "Installed the sign-in window at $apps/$SIGNIN_APP"
  else
    say "This release has no sign-in window: chat apps that sign in on their own website (Instagram) cannot be connected from J-Inbox until the next one."
  fi

  cmd="j-inbox"
  case ":${PATH:-}:" in
    *":$dir:"* | *":$dir/:"*) ;;
    *)
      cmd="$bin"
      # Printed for the person to type, so the ~ is meant literally here.
      # shellcheck disable=SC2088
      case ${SHELL:-} in */bash) profile="~/.bash_profile" ;; *) profile="~/.zprofile" ;; esac
      say ""
      say "$dir is not on your PATH. To type just \`j-inbox\`, run this once, then open a new terminal:"
      say "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> $profile"
      ;;
  esac

  if [ "${J_INBOX_NO_SETUP:-}" = 1 ]; then
    say ""
    say "Next: $cmd setup"
    if [ -f "$HOME/Library/LaunchAgents/build.jsuite.j-inbox.plist" ]; then
      say "(setup restarts the background service, so it runs this version)"
    fi
    return 0
  fi
  # Under `curl | sh` our stdin is the script itself: give setup the terminal instead.
  if ! (: </dev/tty) 2>/dev/null; then
    say ""
    say "No terminal here to answer setup's questions. Next, in Terminal: $cmd setup"
    return 0
  fi
  say ""
  rc=0
  "$bin" setup "$@" </dev/tty || rc=$?
  if [ "$rc" -ne 0 ]; then
    say ""
    say "j-inbox is installed, but setup did not finish. Fix what it said, then run: $cmd setup"
    say "(or run the install again: $INSTALL_CMD)"
    exit "$rc"
  fi
}

main "$@"
