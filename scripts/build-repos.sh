#!/usr/bin/env bash
# Build one Fossil repository per RFC from its real history:
#   1. every distinct version of docs/rfcs/<draft>.txt in zit's repository, in
#      order, each committed with the date, user and comment of the earliest
#      check-in that introduced it;
#   2. the revision in ~/fossil-rfc, if it differs, dated by that file's mtime.
# Output: rfcs/repos/<key>.fossil. Needs zit's repository and ~/fossil-rfc.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
zit=${ZIT_REPO:-$HOME/zit/.zit.fossil}
out="$here/../rfcs/repos"; mkdir -p "$out"
declare -a RFCS=("dl:delta-format" "af:artifact-format" "rs:repo-state" "sp:sync-protocol")
for pair in "${RFCS[@]}"; do
  key="${pair%%:*}"; name="${pair#*:}"
  file="draft-fossil-$name-00.txt"
  repo="$out/$key.fossil"; work="$(mktemp -d)"
  rm -f "$repo"
  first_date="$(fossil sqlite3 -R "$zit" "SELECT datetime(min(e.mtime)) FROM mlink m JOIN filename fn ON fn.fnid=m.fnid JOIN event e ON e.objid=m.mid WHERE fn.name='docs/rfcs/$file'")"
  fossil init --date-override "$first_date" --project-name "draft-fossil-$name" \
    --project-desc "draft-fossil-$name-00" "$repo" >/dev/null
  (cd "$work" && fossil open "$repo" >/dev/null && fossil settings autosync off >/dev/null && fossil settings mtime-changes off >/dev/null)
  # Earliest check-in per distinct file artifact, in time order.
  mapfile -t rows < <(fossil sqlite3 -R "$zit" "SELECT b.uuid, c.uuid, datetime(e.mtime), e.user
      FROM mlink m JOIN filename fn ON fn.fnid=m.fnid JOIN blob b ON b.rid=m.fid
      JOIN blob c ON c.rid=m.mid JOIN event e ON e.objid=m.mid
      WHERE fn.name='docs/rfcs/$file'
      AND e.mtime = (SELECT min(e2.mtime) FROM mlink m2 JOIN event e2 ON e2.objid=m2.mid WHERE m2.fid=m.fid)
      GROUP BY b.uuid ORDER BY min(e.mtime)" </dev/null)
  for row in "${rows[@]}"; do
    IFS='|' read -r fuuid cuuid when user <<< "$row"
    fossil artifact "$fuuid" -R "$zit" > "$work/$file" </dev/null
    comment="$(fossil sqlite3 -R "$zit" "SELECT coalesce(ecomment, comment) FROM event e JOIN blob c ON c.rid=e.objid WHERE c.uuid='$cuuid'" </dev/null)"
    (cd "$work" && { fossil add "$file" >/dev/null 2>&1 || true; } &&
      fossil commit -m "$comment" --date-override "$when" --user-override "$user" --no-warnings >/dev/null)
    echo "$key  $when  ${cuuid:0:10}  file ${fuuid:0:10}"
  done
  rev="/Users/dmestas/fossil-rfc/$file"
  if ! cmp -s "$rev" "$work/$file"; then
    cp "$rev" "$work/$file"
    when="$(date -u -r "$rev" '+%Y-%m-%d %H:%M:%S')"
    (cd "$work" && fossil commit -m "draft-fossil-$name-00 as revised 29 July 2026" \
      --date-override "$when" --user-override dmestas --no-warnings >/dev/null)
    echo "$key  $when  revision from fossil-rfc"
  fi
  (cd "$work" && fossil close --force >/dev/null 2>&1 || true); rm -rf "$work"
  fossil test-integrity -R "$repo" 2>&1 | tail -1 | sed "s/^/$key  /"
done
