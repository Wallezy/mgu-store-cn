#!/bin/sh
# Runs mgu-install with Node 18+: downloads the CN installer, checks it
# against SHA256SUMS, and runs it with the arguments given here
# (deploy/README.md, "mgu-install").
#
#   curl -fsSL https://mgu.walle.pw/mgu/cn/bootstrap/install.sh | sh -s -- first-install --identity ~/.ssh/mgu_root_key
#
# MGU_INSTALL_DOWNLOAD names another folder of the same files (a URL).
# Exit status: mgu-install's, or 1 when it could not be fetched.
set -u

BASE=${MGU_INSTALL_DOWNLOAD:-https://mgu.walle.pw/mgu/cn/bootstrap}

fail() {
    echo "mgu-install: $*" >&2
    exit 1
}

command -v node >/dev/null 2>&1 || fail "Node 18 or newer must be installed before running this installer"
node -e 'process.exit(parseInt(process.versions.node)>=18?0:1)' ||
    fail "Node 18 or newer must be installed before running this installer"
command -v curl >/dev/null 2>&1 || fail "curl is needed to download the installer"
node -e 'process.exit(/(^|\.)(github\.com|githubusercontent\.com|githubassets\.com|github\.io|ghcr\.io)\.?$/i.test(new URL(process.argv[1]).hostname)?1:0)' "$BASE" ||
    fail "GitHub downloads are not supported by the CN launcher"
name=mgu-install.js

if command -v sha256sum >/dev/null 2>&1; then
    sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
    sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
    fail "sha256sum or shasum is needed to check the download"
fi

dir=$(mktemp -d "${TMPDIR:-/tmp}/mgu-install.XXXXXX") || fail "no temporary folder"
trap 'rm -rf "$dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

curl -fsSL --max-redirs 0 -o "$dir/SHA256SUMS" "$BASE/SHA256SUMS" || fail "could not download $BASE/SHA256SUMS"
want=$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$dir/SHA256SUMS")
[ -n "$want" ] || fail "$BASE/SHA256SUMS lists no $name"
curl -fSL --max-redirs 0 --progress-bar -o "$dir/$name" "$BASE/$name" || fail "could not download $BASE/$name"
got=$(sum "$dir/$name")
[ "$got" = "$want" ] || fail "$name does not match SHA256SUMS (sha256 $got, expected $want); nothing was run. Try again in a minute"

# Through `curl | sh` stdin is the script, so prompts read the terminal.
if [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
    node "$dir/$name" "$@" </dev/tty
else
    node "$dir/$name" "$@"
fi
exit $?
