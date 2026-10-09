#!/bin/sh
# Push trunk to the GitHub mirror, github.com/danmestas/Illustrated-Fossil-RFC.
#
# The mirror is a derived view: zit is the repository, and nothing is ever
# committed on the Git side. Each run exports the whole history into a fresh
# Git repository and pushes main fast-forward only; the export is
# deterministic, so a run that brings nothing new pushes nothing.
#
# Needs GITHUB_MIRROR_KEY, the private half of the repository's write deploy
# key, as ci/mirror.yml gives it from the production environment.
set -eu
cd "$(dirname "$0")/.."
: "${GITHUB_MIRROR_KEY:?mirror: GITHUB_MIRROR_KEY is not set}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
umask 077
printf '%s\n' "$GITHUB_MIRROR_KEY" >"$work/key"
# GitHub's published host key, so the first connection is not a trust-on-first-use.
echo 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' >"$work/known_hosts"
export GIT_SSH_COMMAND="ssh -i $work/key -o IdentitiesOnly=yes -o UserKnownHostsFile=$work/known_hosts -o StrictHostKeyChecking=yes"
zit git export "$work/git" --autopush git@github.com:danmestas/Illustrated-Fossil-RFC.git --quiet
zit git status
