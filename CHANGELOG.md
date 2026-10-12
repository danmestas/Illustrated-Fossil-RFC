# Changelog

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
