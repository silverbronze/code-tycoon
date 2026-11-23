#!/bin/sh
# Code Tycoon installer for macOS and Linux. What it does and how to undo it: https://codetycoon.dev/setup.txt
#
#   curl -fsSL https://codetycoon.dev/install.sh | sh -s -- --code ABCD-EFGH
#
# 1. Uses your Node if it is 22.13 or newer. Otherwise downloads the official Node 22 LTS build from
#    nodejs.org, checks it against nodejs.org's SHA256SUMS, and unpacks it into ~/.codetycoon/node.
# 2. Installs the code-tycoon npm package into ~/.codetycoon/pkg/<version>.
# 3. Runs `code-tycoon setup`: Claude Code hooks, start at login, the server, and (with --code) the
#    connection to your account at app.codetycoon.dev.
# No sudo, nothing on PATH, nothing outside ~/.codetycoon except the hooks in ~/.claude/settings.json
# (backed up first) and the login item. Run it again to update. Undo: ~/.codetycoon/bin/code-tycoon uninstall
set -eu
CODE=""; RELAY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --code) CODE="${2:-}"; shift 2 ;;
    --relay) RELAY="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
CT="$HOME/.codetycoon"
NODE_DIR="$CT/node"
PKG="${CT_PACKAGE:-code-tycoon@latest}"
die() { echo "Code Tycoon setup failed: $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || die "curl is missing"
command -v tar >/dev/null 2>&1 || die "tar is missing"
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' >/dev/null 2>&1; }

NODE=""
if [ -z "${CT_FORCE_NODE:-}" ] && command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
elif [ -x "$NODE_DIR/bin/node" ] && node_ok "$NODE_DIR/bin/node"; then
  NODE="$NODE_DIR/bin/node"
else
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) die "this system ($(uname -s)) is not supported" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) die "this CPU ($(uname -m)) is not supported" ;; esac
  echo "Downloading Node 22 LTS from nodejs.org..."
  base=https://nodejs.org/dist/latest-v22.x
  sums="$(curl -fsSL "$base/SHASUMS256.txt")" || die "Node download failed: no internet?"
  file="$(printf '%s\n' "$sums" | awk -v s="-$os-$arch.tar.gz" 'substr($2, length($2) - length(s) + 1) == s { print $2; exit }')"
  [ -n "$file" ] || die "nodejs.org has no Node 22 build for $os-$arch"
  want="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1 }')"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$base/$file" -o "$tmp/$file" || die "Node download failed: no internet?"
  got="$( (sha256sum "$tmp/$file" 2>/dev/null || shasum -a 256 "$tmp/$file") | awk '{ print $1 }')"
  [ "$got" = "$want" ] || die "the Node download does not match nodejs.org's checksum"
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  NODE="$NODE_DIR/bin/node"
fi
echo "Node: $NODE ($("$NODE" --version))"

NPM_CLI="$(dirname "$NODE")/../lib/node_modules/npm/bin/npm-cli.js"
npm_() { if [ -f "$NPM_CLI" ]; then "$NODE" "$NPM_CLI" "$@"; else npm "$@"; fi; }

echo "Installing $PKG..."
STAGE="$CT/pkg/.staging"
rm -rf "$STAGE"
mkdir -p "$STAGE"
npm_ install "$PKG" --prefix "$STAGE" --omit=dev --no-audit --no-fund --loglevel=error >/dev/null || die "npm could not install code-tycoon: no internet?"
VER="$("$NODE" -p 'require(process.argv[1]).version' "$STAGE/node_modules/code-tycoon/package.json")" || die "the package did not install completely"
DEST="$CT/pkg/$VER"
if [ -f "$DEST/node_modules/code-tycoon/package.json" ]; then
  rm -rf "$STAGE"   # this version is already here (and may be running): keep it
else
  rm -rf "$DEST"
  mv "$STAGE" "$DEST"
fi
echo "Code Tycoon $VER: $DEST"

set -- setup
[ -n "$CODE" ] && set -- "$@" --code "$CODE"
[ -n "$RELAY" ] && set -- "$@" --relay "$RELAY"
"$NODE" --no-warnings "$DEST/node_modules/code-tycoon/bin/code-tycoon.mjs" "$@" || exit 1
