# Changelog

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
