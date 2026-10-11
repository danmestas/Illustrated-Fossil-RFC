#!/bin/sh
# Rebuild the two go-libfossil programs, compiled against go-libfossil at the
# commit in wasm/GO-LIBFOSSIL:
#
#   wasm/rfcrepo.wasm.gz    wasm/main.go, which the page's Repository view runs
#   wasm/rfcserver.wasm.gz  wasm/server/main.go, which answers sync in the Worker
#
# main.go uses go-libfossil's internal packages, so both are built from inside
# a checkout of that module, as its examples/rfcrepo and examples/rfcserver.
#
#   sh wasm/build.sh [GO_LIBFOSSIL_CHECKOUT]   # default ~/projects/go-libfossil
#
# The flags make the build depend only on the source and the Go version:
# Go 1.27.1 at the pinned commit gives the committed files byte for byte.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
src=${1:-$HOME/projects/go-libfossil}
pin=$(cat "$here/GO-LIBFOSSIL")
work=$(mktemp -d)
trap 'git -C "$src" worktree remove --force "$work/glf" 2>/dev/null; rm -rf "$work"' EXIT INT TERM
git -C "$src" worktree add --detach "$work/glf" "$pin" >/dev/null
for prog in rfcrepo:main.go rfcserver:server/main.go; do
  name=${prog%%:*}
  mkdir -p "$work/glf/examples/$name"
  cp "$here/${prog#*:}" "$work/glf/examples/$name/main.go"
  (cd "$work/glf" && GOOS=js GOARCH=wasm go build -buildvcs=false -trimpath -ldflags="-s -w" -o "$work/$name.wasm" "./examples/$name")
  gzip -9n <"$work/$name.wasm" >"$here/$name.wasm.gz"
  echo "built wasm/$name.wasm.gz from go-libfossil $(echo "$pin" | cut -c1-12) with $(go env GOVERSION)"
done
