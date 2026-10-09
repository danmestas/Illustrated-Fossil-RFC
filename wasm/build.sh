#!/bin/sh
# Rebuild wasm/rfcrepo.wasm.gz: wasm/main.go compiled against go-libfossil at
# the commit in wasm/GO-LIBFOSSIL. main.go uses go-libfossil's internal
# packages, so it is built from inside a checkout of that module, as its
# examples/rfcrepo.
#
#   sh wasm/build.sh [GO_LIBFOSSIL_CHECKOUT]   # default ~/projects/go-libfossil
#
# The flags make the build depend only on the source and the Go version:
# Go 1.27.1 at the pinned commit gives the committed file byte for byte.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
src=${1:-$HOME/projects/go-libfossil}
pin=$(cat "$here/GO-LIBFOSSIL")
work=$(mktemp -d)
trap 'git -C "$src" worktree remove --force "$work/glf" 2>/dev/null; rm -rf "$work"' EXIT INT TERM
git -C "$src" worktree add --detach "$work/glf" "$pin" >/dev/null
mkdir -p "$work/glf/examples/rfcrepo"
cp "$here/main.go" "$work/glf/examples/rfcrepo/main.go"
(cd "$work/glf" && GOOS=js GOARCH=wasm go build -buildvcs=false -trimpath -ldflags="-s -w" -o "$work/rfcrepo.wasm" ./examples/rfcrepo)
gzip -9n <"$work/rfcrepo.wasm" >"$here/rfcrepo.wasm.gz"
echo "built wasm/rfcrepo.wasm.gz from go-libfossil $(echo "$pin" | cut -c1-12) with $(go env GOVERSION)"
