# Illustrated Fossil RFCs

The four Fossil RFC drafts — the Delta Format, Artifact Format, Repository
State and Sync Protocol — as one site. Each draft has three views:

- **Illustrated**: a reading of the draft, section by section, with Pikchr
  figures and small tools (a delta playground, an artifact inspector, a sync
  replay).
- **Draft text**: the draft itself, rendered from the repository's tip, with
  tables, code literals, syntax diagrams for every ABNF block, what each
  version changed. The artifact-format, repo-state and sync-protocol pages
  show the -01 revisions, which folded every erratum into the text.
- **Repository**: the Fossil repository, opened in the browser by
  go-libfossil compiled to WebAssembly: its timeline and storage, a check of
  every artifact's name, a rebuild of the derived tables, and an animated
  sync between two copies.

One Fossil repository holds every draft, the errata the -01 revisions
folded in, and their real history. It is also a Fossil server, so stock `fossil` can clone, pull and
push it:

```sh
fossil clone https://illustrated-fossil-rfc.daniel-mestas.workers.dev/rfcs fossil-rfcs.fossil
```

Anyone can clone and pull. Pushing needs one of the accounts in the Worker
secret `FOSSIL_PUSHERS`, one `login:password` per line:

```sh
npx wrangler secret put FOSSIL_PUSHERS
```

The site once served one repository per draft, at `/delta-format`,
`/artifact-format`, `/repo-state` and `/sync-protocol`. Those URLs now answer
a sync with an error naming `/rfcs`.

It is served as a Cloudflare Worker, `illustrated-fossil-rfc`. Cloudflare
serves the built site as static assets. The Worker script
(`worker/index.js`) answers the rest. A Durable Object holds the repository:
it starts as the copy the site publishes, `repos/rfcs.fossil`, and keeps
every check-in pushed to it since. A sync request to `/rfcs` is answered
against that copy by a second go-libfossil program, `wasm/server/main.go`,
and `GET /repos/rfcs.fossil` serves it, so the page and its download show
what was pushed. When a release publishes check-ins the stored copy lacks,
they are pulled in. The stored copy never holds a login: the pushers'
accounts exist only in memory, for the request that uses them.

For `wrangler dev`, put test accounts in `.dev.vars`
(`FOSSIL_PUSHERS="tester:a-password"`), which is not checked in.

## Building and testing

Node 22 or later, and `fossil` on the PATH (the build reads each draft from
the repository).

```sh
npm test              # build checks, renderer, syntax diagrams, delta codec, go-libfossil, sync server
npm run build         # the site, into dist/
npm start             # build and serve dist/ on http://127.0.0.1:8790
npm run build:artifact  # the claude.ai artifact layout, into dist-artifact/
```

`node build.js --target worker|artifact OUT` is the build. The artifact
target writes the same page for a host that serves only web types, with each
binary as base64 text beside it.

## Layout

| Path | Holds |
|---|---|
| `page.html` | the site: styles, the Delta reading, and every script |
| `rfcs/{af,rs,sp}/` | the other three readings: `illustrated.html`, figures in `d/`, captions, tools |
| `figures/` | the Delta reading's figures |
| `rfc-render.js`, `rfcs/code-terms.*`, `rfcs/rfc-table.css` | the draft-text renderer and its code literals |
| `railroad.js` | ABNF to Pikchr syntax diagrams |
| `delta.js` | Fossil's delta codec, for the playground |
| `rfcs/repos/rfcs.fossil` | the repository: every draft and erratum, built by `scripts/build-repo.mjs` |
| `wasm/` | the go-libfossil programs the Repository view and the sync server run, and their build |
| `worker/` | the Worker script and its Durable Object: the repository as a Fossil server |
| `vendor/` | Pikchr's WebAssembly build (from pikchr-studio) and Go's `wasm_exec.js` (Go 1.27.1) |

## The go-libfossil build

`wasm/rfcrepo.wasm.gz` (the Repository view, from `wasm/main.go`) and
`wasm/rfcserver.wasm.gz` (the sync server, from `wasm/server/main.go`) are
committed. `wasm/main.go` uses go-libfossil's internal packages, so both are
compiled inside a checkout of that module, at the commit in
`wasm/GO-LIBFOSSIL`:

```sh
sh wasm/build.sh ~/projects/go-libfossil
```

With Go 1.27.1 the results are byte for byte the committed files.

## The repositories

`node scripts/build-repo.mjs` rebuilds `rfcs/repos/rfcs.fossil`. zit is the
authoritative home of the drafts and errata (`docs/rfcs/` in zit's
repository); the build replays their history:

1. the original drafts in `~/fossil-rfc`'s repository, from before zit took
   them over;
2. zit's history of `docs/rfcs/draft-fossil-*.txt` and `docs/rfcs/erratum/*`.

Each distinct version of a file is committed once, with the date, author and
comment of the check-in that introduced it. Drafts sit at the repository's
root and errata under `erratum/`. The project code is fixed, so a rebuild is
the same project: existing clones keep pulling, and the Worker's stored copy
merges it in.

The repository is published and served, so the build clears every
account's password and capabilities but `nobody`'s: no one can log in to
it, and `nobody` can clone and pull but not push.

## Releases

1. Add a `## X.Y.Z` section at the top of `CHANGELOG.md` and land it.
2. Tag the landed trunk check-in and push: `zit tag add version-X.Y.Z CHECKIN`.
3. The tag starts `ci/release.yml` on zeitforge: the tests, then
   `scripts/release.sh X.Y.Z`, which refuses unless the changelog agrees and
   then runs `wrangler deploy`.

The Cloudflare API token is the `production` environment's secret in the
repository's settings, given to trunk check-ins only. To repeat a release,
cancel the tag and add it again. Every push and landing runs `ci/test.yml`:
the tests and `wrangler deploy --dry-run`.

## Where it lives

The repository is [zeitforge.app/r/Illustrated-Fossil-RFC](https://zeitforge.app/r/Illustrated-Fossil-RFC).
[github.com/danmestas/Illustrated-Fossil-RFC](https://github.com/danmestas/Illustrated-Fossil-RFC)
is a mirror of trunk, pushed by `ci/mirror.yml` after every trunk check-in
(`scripts/mirror.sh`, with a deploy key from the `production` environment).
Nothing is committed on the GitHub side.

## License

The code is under the [Zero-Clause BSD license](LICENSE). The drafts in
`rfcs/repos/` are Internet-Drafts and carry their own copyright notice.
