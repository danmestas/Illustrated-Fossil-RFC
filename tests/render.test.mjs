// The draft-text renderer and the syntax diagrams, on every draft's tip.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, "..");
const rfcRender = require("../rfc-render.js");
const { railroad, pikchrMeasure } = require("../railroad.js");
const codeTerms = JSON.parse(fs.readFileSync(path.join(root, "rfcs/code-terms.json"), "utf8"));
const KEYS = { dl: "delta-format", af: "artifact-format", rs: "repo-state", sp: "sync-protocol" };
const draft = (key) => execFileSync("fossil", ["cat", "-R", path.join(root, "rfcs/repos/rfcs.fossil"), "-r", "trunk", `draft-fossil-${KEYS[key]}-00.txt`], { encoding: "utf8", maxBuffer: 1 << 26 });
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const words = (s) => s.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;/g, " ").split(/[^A-Za-z0-9]+/).filter(Boolean).sort();

const pikchr = await require("../vendor/pikchr.js")();
const pk = pikchr.cwrap("pikchr", "number", ["string", "string", "number", "number", "number"]);
const render = (src) => { const p = pk(src, "pikchr", 1, 0, 0); const o = pikchr.UTF8ToString(p); pikchr._free(p); return o; };
const measure = pikchrMeasure(render);

const TABLES = { dl: 0, af: 11, rs: 0, sp: 7 };
for (const key of Object.keys(KEYS)) {
  test(`${KEYS[key]}: rendered text keeps every word and draws its tables`, () => {
    const text = draft(key);
    const r = rfcRender(text, { codeTerms: codeTerms[key] });
    const html = r.head + r.body + r.boiler;
    assert.equal((r.body.match(/<table class="rfc-table"/g) || []).length, TABLES[key]);
    for (const p of r.body.match(/<p(?:\s[^>]*)?>[\s\S]*?<\/p>/g) || []) assert.doesNotMatch(p, /\+-{3}|\+={3}/, "a table border leaked into prose");
    // Every word of the text survives, apart from page furniture.
    const have = new Map();
    for (const w of words(unesc(html))) have.set(w, (have.get(w) || 0) + 1);
    const furniture = /^(Internet|Draft|Expires|Page|Hipp|et|al|January|July|2026|2027|\d+)$/;
    // The page has its own contents rail, so the draft's table of contents is dropped.
    const toc = text.indexOf("Table of Contents"), body = text.search(/^1\.\s+Introduction$/m);
    const kept = toc >= 0 && body > toc ? text.slice(0, toc) + text.slice(body) : text;
    for (const w of words(kept)) if (!furniture.test(w)) assert.ok(have.get(w), `lost "${w}"`);
  });
}

test("every ABNF block in the drafts draws, and formulas are left alone", () => {
  let blocks = 0;
  for (const key of Object.keys(KEYS)) {
    for (const m of rfcRender(draft(key)).body.matchAll(/<pre class="rfc-fig"[^>]*>([\s\S]*?)<\/pre>/g)) {
      const g = railroad(unesc(m[1]), measure);
      if (!g) continue;
      blocks++;
      for (const r of g.rules) assert.match(render(r.src), /^<svg/, `${key} ${r.name}`);
    }
  }
  assert.ok(blocks >= 30, `${blocks} ABNF blocks`);
  assert.equal(railroad('shared-secret = SHA1(project-code "/" login-name "/" plaintext-password)', measure), null);
  assert.equal(railroad("ctx = MD5-Init()", measure), null);
});

test("ABNF constructs map to the diagram's shapes", () => {
  const g = railroad('rule = "a" / ( %x41-5A *DIGIT ) [ SP name ] 40HEXDIG', measure);
  assert.ok(g);
  const src = g.rules[0].src;
  assert.match(src, /oval "a" mono/);
  assert.match(src, /oval "A–Z" mono/);
  assert.match(src, /box "name"/);
  assert.match(src, /"40 times"/);
});
