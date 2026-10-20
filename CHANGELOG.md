# Changelog

## 0.6.7

- The artifact-format, repo-state and sync-protocol texts name themselves
  -00 again: they are their -00 drafts revised in place, and their
  appendix is now "Changes in This Revision". No normative text changed.
  The draft pages, the reading headers and the tests say -00 to match.
  The served repository gains the one check-in that relabels them, so
  existing clones pull it and nothing forks.

## 0.6.6

- The served repository carries the 19 October revisions of the
  sub-manifests and sparse-cone drafts: the sub-manifest peer gate becomes
  the send-submanifests pragma, clone-time adoption and the history replay
  are specified, the provisional phase retires, and sparse-cone's literal
  prefix and exclusion rules are merged. Every erratum is now applied in its
  draft, so the erratum files leave the tip; their history stays.
- The build replays zit's trunk only: a version counts once trunk descends
  from the check-in that introduced it, and every change a trunk check-in
  makes, a deletion or a return to an earlier text, is replayed there. The
  horizon branch's unlanded work stays out; its merge of 17 October, backed
  out the same day, appears and is undone as it was. Nothing earlier in the
  history changed, so existing clones pull the new check-ins and nothing
  forks.

## 0.6.5

- The served repository carries three more errata of 16 October. The
  artifact-format §4.4 and §6.2 erratum says the Z card is last because
  of the ordering and required-card rules, not the checksum framing,
  which reads the final 35 bytes by position. The §4.7.8 erratum says an
  absent and an empty J value decode alike and a reader must not tell
  them apart. The sync-protocol §6.6 erratum lets a server append words
  to a "not authorized to ..." refusal, as Fossil does with its
  localauth setting, and has clients match the leading text. Nothing
  earlier in the history changed, so existing clones pull the three
  check-ins and nothing forks.

## 0.6.4

- The served repository's artifact-format §4.7.3 erratum names the Fossil
  check-in, 4886b7de6d of 14 October, that stops zip, tarball and sqlar
  crashing on a named delta's delete markers; Fossil 2.28 still crashes.
  The change is one check-in after the 0.6.3 tip, so existing clones pull
  it and nothing forks.

## 0.6.3

- The served repository carries two more errata of 14 October. The
  artifact-format §4.7.3 erratum says a named delta's delete markers are
  filtered like the delta's own, and records that Fossil 2.28's zip,
  tarball and sqlar crash on them and that its file-change records for
  such a check-in are left undefined. The repo-state §5.3 and §6.2 erratum
  says an artifact's tag cards apply in card order, so a branch root that
  both applies and cancels its own sym tag keeps it. Nothing earlier in
  the history changed, so existing clones pull the two check-ins and
  nothing forks.

## 0.6.2

- The served repository carries two more check-ins of the drafts: the
  sync-protocol §9.4 correction (the forbid-delta-manifests default is
  Fossil 2.29's; 2.28 defaults off) and the repo-state §5.3 erratum of 14
  October, under which a cancel's value stays on the stored row as Fossil
  writes it and only the cached state and the propagation walk treat it as
  null. Nothing earlier in the history changed, so existing clones pull the
  two check-ins and nothing forks.

## 0.6.1

- go-libfossil v0.12.0, from v0.11.1. The sync server and the in-browser
  repository now carry the fixes behind the 13 October errata: one
  transaction per sync round, a received delta verified against its hash
  before it is stored, ci-lock and ci-unlock for any requester, a pushed
  file that fails its handler ending the round, and the leaf table kept
  incrementally.
- With that release the server announces itself as one that reads the
  login card from the x-f-l-c cookie, so fossil moves its login there after
  a push's first round; the Worker passes the cookie through. That first
  round also records the artifacts to come as phantoms, and the round that
  fills them in is now kept as a change.
- A push without an account is refused with Fossil's own words, "not
  authorized to write".

## 0.6.0

- Each draft is one file again. The -01 texts of the artifact-format,
  repo-state and sync-protocol drafts were separate files from 12 October,
  so their History began at the fold and the -00 history ended there. zit's
  -00 files now carry every erratum as its own check-in, up to a check-in
  that makes each one its -01 revision, and the separate -01 files are
  gone; the repository is rebuilt from that history, so History runs from
  the first draft to the current revision and Changes marks each erratum.
- Four more errata, applied: leaf rechecks only on branch-tag events, the
  skip test against an inherited row, and the ckout keyword, in repository
  state; the ci-lock reply's avoid-delta-manifests pragma in the sync
  protocol.
- The Worker starts a fresh stored copy of the repository, since the
  rebuilt history cannot be merged into the old one. A clone made before
  this release sees the rewritten history as a fork on its next pull.

## 0.5.1

- The Draft text view lists each version of a draft under the check-in that
  changed it. Since 0.4.0 every draft shares one repository, and a version
  was listed under the newest check-in that merely carried it, so the tip
  bore the wrong date and comment, Changes marked nothing, and History
  left most blocks without a chip.

## 0.5.0

- The artifact-format, repo-state and sync-protocol pages show the -01
  revisions of the drafts, which fold every erratum into the text; the
  readings' section numbers are unchanged.
- The Draft text view no longer lists errata, since the text it shows has
  them applied. The erratum files stay in the repository's history, and the
  -00 texts stay beside the -01 texts.
- The repository gains the -01 drafts and six further errata, all applied.

## 0.4.1

- Fourteen more errata, each checked against Fossil 2.28: two for the
  artifact format, three for repository state and nine for the sync
  protocol.
- The readings follow zit's drafts where the 29 July text they were written
  against had changed, and keep the 29 July behaviour where Fossil does what
  it said (those places now have errata).

## 0.4.0

One Fossil repository, `/rfcs`, holds every draft and every erratum.

- Its history replays zit's, which is authoritative for the drafts, from the
  original drafts before zit onward. The drafts are now zit's text.
- The Draft text view lists the errata filed against each draft.
- The per-draft repositories at `/delta-format`, `/artifact-format`,
  `/repo-state` and `/sync-protocol` are retired: a sync to them answers with
  an error naming `/rfcs`.
- The sync and repo-state readings cite zit's section numbers.

## 0.3.1

- go-libfossil 0.11.1: the sync server sends content only to a client that
  may read it, and a sync never follows a redirect from HTTPS to HTTP.

## 0.3.0

Each draft's repository takes pushes. Anyone can clone and pull; the accounts
in the Worker secret `FOSSIL_PUSHERS` can push.

- One Durable Object per draft holds its repository and every check-in
  pushed to it. The Repository view and its download show the repository as
  it is now.
- A release that publishes check-ins the stored repository lacks pulls them
  in.
- The Repository view says how to clone, pull and push.
- go-libfossil 0.11.0: a pull-only sync converges when the puller holds
  artifacts the server lacks, and a login needs a non-empty password.

## 0.2.0

Each draft's repository can be cloned and pulled with stock `fossil`, from
`/delta-format`, `/artifact-format`, `/repo-state` and `/sync-protocol`.

- The Worker answers Fossil's sync protocol with a second go-libfossil
  program, from a fresh copy of the repository per request. It is read-only:
  a push is refused.
- The repositories carry no account that can log in: every password and
  capability but `nobody`'s is cleared.

## 0.1.0

The four Fossil RFC drafts as one site on Cloudflare Workers: the Delta
Format, Artifact Format, Repository State and Sync Protocol, each with an
illustrated reading, the draft's own text and its Fossil repository.

- Illustrated readings with Pikchr figures, drawn in the browser.
- Draft text rendered from each repository's tip, with tables, code literals,
  syntax diagrams for every ABNF block, per-version changes and line history.
- Each draft's repository opened in the browser by go-libfossil: timeline,
  storage, name check, rebuild, and an animated sync between two copies.
- The repository downloads as a `.fossil` file.
