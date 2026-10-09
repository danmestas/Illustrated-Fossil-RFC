# Changelog

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
