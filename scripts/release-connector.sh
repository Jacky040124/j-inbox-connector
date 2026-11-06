#!/bin/sh
# Build the connector release assets from a clean checkout of HEAD, and print (never run) the
# `gh release create` command that publishes them.
#
#   scripts/release-connector.sh [--out DIR] [--allow-dirty] [--reuse-node-modules]
#
#   --out DIR              where the assets go (default: a new temp dir); must be empty or absent
#   --allow-dirty          build even with uncommitted changes (HEAD is built; the changes are NOT in it)
#   --reuse-node-modules   offline: symlink this checkout's node_modules instead of `bun install`
#
# Output: j-inbox-darwin-arm64 (Mach-O arm64, ad-hoc signed), j-inbox-darwin-arm64.sha256
# (`shasum -a 256` line, file name only), j-inbox-signin-darwin-arm64.tar.gz (J-Inbox Sign-in.app,
# the sign-in window, built by connector/signin-helper/build.sh, ad-hoc signed) with its .sha256,
# and install.sh (connector/install.sh of HEAD, which installs both).
# Needs macOS (file, codesign, shasum, swiftc from Xcode's command line tools) and bun. Publishes nothing.
set -eu

ASSET="j-inbox-darwin-arm64"
SIGNIN_ASSET="j-inbox-signin-darwin-arm64.tar.gz"
PUBLIC_REPO="Jacky040124/j-inbox-connector"

die() {
  printf 'release-connector: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "${work:-}" ]; then rm -rf "$work"; fi
}

main() {
  out=""
  allow_dirty=0
  reuse_nm=0
  while [ $# -gt 0 ]; do
    case $1 in
      --out) [ $# -ge 2 ] || die "--out needs a directory."; out=$2; shift 2 ;;
      --allow-dirty) allow_dirty=1; shift ;;
      --reuse-node-modules) reuse_nm=1; shift ;;
      -h | --help) sed -n '2,14p' "$0"; exit 0 ;;
      *) die "Unknown option $1." ;;
    esac
  done

  [ "$(uname -s)" = Darwin ] || die "Run this on macOS (it needs codesign)."
  for t in git bun file codesign shasum tar swiftc; do command -v "$t" >/dev/null 2>&1 || die "$t is missing."; done

  root=$(cd "$(dirname "$0")/.." && git rev-parse --show-toplevel) || die "Not inside the j-inbox git checkout."
  cd "$root"
  dirty=$(git status --porcelain)
  if [ -n "$dirty" ]; then
    if [ "$allow_dirty" = 1 ]; then
      echo "Warning: the tree has uncommitted changes; building HEAD without them (--allow-dirty)."
    else
      printf '%s\n' "$dirty" | head -20 >&2
      die "The tree has uncommitted changes. Commit them first, or pass --allow-dirty to build HEAD anyway."
    fi
  fi
  commit=$(git rev-parse HEAD)
  short=$(git rev-parse --short=12 HEAD)

  if [ -z "$out" ]; then out=$(mktemp -d "${TMPDIR:-/tmp}/j-inbox-release.XXXXXX"); fi
  mkdir -p "$out"
  out=$(cd "$out" && pwd -P)
  [ -z "$(ls -A "$out")" ] || die "$out is not empty."

  work=$(mktemp -d "${TMPDIR:-/tmp}/j-inbox-release-build.XXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP

  echo "Clean checkout of HEAD $short in $work"
  git archive --format=tar HEAD | tar -x -C "$work"
  cd "$work"
  [ -f connector/install.sh ] || die "HEAD has no connector/install.sh (commit it first)."
  if [ "$reuse_nm" = 1 ]; then
    [ -d "$root/node_modules" ] || die "No node_modules in $root to reuse."
    echo "Reusing $root/node_modules (symlink; --reuse-node-modules)"
    ln -s "$root/node_modules" "$work/node_modules"
    for d in "$root"/*/node_modules; do
      [ -d "$d" ] || continue
      pkg=$(basename "$(dirname "$d")")
      [ -d "$work/$pkg" ] && ln -s "$d" "$work/$pkg/node_modules"
    done
  else
    echo "bun install --frozen-lockfile"
    bun install --frozen-lockfile >"$work/.bun-install.log" 2>&1 || {
      tail -20 "$work/.bun-install.log" >&2
      die "bun install failed (offline? try --reuse-node-modules)."
    }
  fi

  version=$(sed -n 's/^export const CONNECTOR_VERSION = "\([^"]*\)";.*$/\1/p' connector/src/version.ts)
  [ -n "$version" ] || die "Cannot read CONNECTOR_VERSION from connector/src/version.ts."

  echo "Building the connector $version"
  (cd connector && bun run build) >"$work/.build.log" 2>&1 || {
    tail -20 "$work/.build.log" >&2
    die "bun run build failed."
  }
  bin="$work/connector/dist/j-inbox"
  [ -f "$bin" ] || die "The build made no connector/dist/j-inbox."

  kind=$(file -b "$bin")
  case $kind in
    "Mach-O 64-bit executable arm64"*) echo "file: $kind" ;;
    *) die "connector/dist/j-inbox is not a Mach-O arm64 executable: $kind" ;;
  esac

  # bun build --compile writes its payload after the linker's ad-hoc signature, so `codesign -v`
  # says "invalid signature". Apple silicon runs only signed arm64 code and Gatekeeper checks the
  # signature, so sign it again (ad-hoc: no Apple developer account) and verify.
  if codesign -v "$bin" 2>/dev/null; then
    echo "codesign: the signature is already valid"
  else
    echo "codesign: signing ad-hoc (the build's signature does not verify)"
    codesign --sign - --force --identifier j-inbox "$bin" >/dev/null 2>&1 || die "codesign --sign - failed."
  fi
  codesign -v --strict "$bin" || die "codesign -v failed after signing."
  codesign -dv "$bin" 2>&1 | grep -E '^(Identifier|Signature|CodeDirectory)' | sed 's/^/  /'

  got=$("$bin" --version </dev/null) || die "dist/j-inbox --version failed."
  [ "$got" = "$version" ] || die "dist/j-inbox --version says $got, but connector/src/version.ts says $version."
  "$bin" --help </dev/null >/dev/null || die "dist/j-inbox --help failed."
  echo "dist/j-inbox --version: $got"

  cp "$bin" "$out/$ASSET"
  chmod 755 "$out/$ASSET"
  codesign -v --strict "$out/$ASSET" || die "The copied binary does not verify."
  (cd "$out" && shasum -a 256 "$ASSET" >"$ASSET.sha256" && shasum -a 256 -c "$ASSET.sha256" >/dev/null) || die "Checksum file failed."
  # The sign-in window (the small app the connector opens for a website's own sign-in), as install.sh unpacks it.
  echo "Building the sign-in window"
  sh connector/signin-helper/build.sh "$work/signin" >"$work/.signin.log" 2>&1 || {
    tail -20 "$work/.signin.log" >&2
    die "connector/signin-helper/build.sh failed."
  }
  app="$work/signin/J-Inbox Sign-in.app"
  kind=$(file -b "$app/Contents/MacOS/J-Inbox Sign-in")
  case $kind in
    "Mach-O 64-bit executable arm64"*) echo "file: $kind" ;;
    *) die "The sign-in window is not a Mach-O arm64 executable: $kind" ;;
  esac
  codesign -v --strict "$app" || die "codesign -v failed for the sign-in window."
  (cd "$work/signin" && COPYFILE_DISABLE=1 tar -czf "$out/$SIGNIN_ASSET" "J-Inbox Sign-in.app") || die "Could not pack the sign-in window."
  (cd "$out" && shasum -a 256 "$SIGNIN_ASSET" >"$SIGNIN_ASSET.sha256" && shasum -a 256 -c "$SIGNIN_ASSET.sha256" >/dev/null) || die "Checksum file failed for the sign-in window."

  cp connector/install.sh "$out/install.sh"
  sh -n "$out/install.sh" || die "install.sh does not parse."

  sum=$(cut -d' ' -f1 "$out/$ASSET.sha256")
  tag="v$version"
  echo ""
  echo "Release assets in $out:"
  for f in "$ASSET" "$ASSET.sha256" "$SIGNIN_ASSET" "$SIGNIN_ASSET.sha256" install.sh; do printf '  %s (%s bytes)\n' "$f" "$(wc -c <"$out/$f" | tr -d ' ')"; done
  echo "  sha256 $sum"
  echo ""
  echo "Before publishing:"
  echo "  1. Sync the public repo $PUBLIC_REPO first: its connector/ (with protocol/ and"
  echo "     fake-beeper/) must match this commit, $commit."
  if git -C "$root" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    echo "  (note: this repo already has a tag $tag; bump CONNECTOR_VERSION if $tag is already released)"
  fi
  echo "  2. Publish (the release must be marked latest: install.sh downloads releases/latest/download):"
  echo ""
  echo "gh release create $tag --repo $PUBLIC_REPO --latest \\"
  echo "  --title \"j-inbox $version\" \\"
  echo "  --notes \"J-Inbox connector $version for macOS on Apple silicon. Install or upgrade: curl -fsSL https://inbox.jackyzhonghq.com/install.sh | sh  (SHA-256 of $ASSET: $sum)\" \\"
  echo "  $out/$ASSET \\"
  echo "  $out/$ASSET.sha256 \\"
  echo "  $out/$SIGNIN_ASSET \\"
  echo "  $out/$SIGNIN_ASSET.sha256 \\"
  echo "  $out/install.sh"
  echo ""
  echo "  3. https://inbox.jackyzhonghq.com/install.sh is served from web/dist, which web/build.ts"
  echo "     rebuilds from connector/install.sh: deploy the Worker (after the release exists) to"
  echo "     publish this install.sh."
  echo "  4. Check: curl -fsSLI https://github.com/$PUBLIC_REPO/releases/latest/download/$ASSET.sha256"
}

main "$@"
