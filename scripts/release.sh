#!/bin/sh
# Deploy release X.Y.Z to the illustrated-fossil-rfc Worker.
#
#   sh scripts/release.sh X.Y.Z
#
# Refuses unless CHANGELOG.md's newest section is "## X.Y.Z": the changelog
# names the release, the tag only points at it. wrangler deploy builds the
# site into dist/ first (wrangler.jsonc). Needs CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID, as ci/release.yml gives them.
set -eu
cd "$(dirname "$0")/.."
version=${1:?usage: release.sh X.Y.Z}
case $version in
  *[!0-9.]* | "" | .* | *. | *..*) echo "release: '$version' is not X.Y.Z" >&2; exit 2 ;;
esac
newest=$(sed -n 's/^## \([0-9][0-9.]*\).*/\1/p' CHANGELOG.md | head -1)
if [ "$newest" != "$version" ]; then
  echo "release: CHANGELOG.md's newest section is '$newest', not '$version'" >&2
  exit 1
fi
: "${CLOUDFLARE_API_TOKEN:?release: CLOUDFLARE_API_TOKEN is not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?release: CLOUDFLARE_ACCOUNT_ID is not set}"
npx --yes wrangler@4.138.0 deploy
echo "release: $version deployed"
