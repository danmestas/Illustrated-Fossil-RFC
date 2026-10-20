// The go-libfossil build the page runs, against the repository it ships.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import "../vendor/wasm_exec.js";

const root = path.join(import.meta.dirname, "..");
const go = new globalThis.Go();
const wasm = zlib.gunzipSync(fs.readFileSync(path.join(root, "wasm/rfcrepo.wasm.gz")));
const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
await new Promise((ready) => { globalThis.onFossilReady = ready; go.run(instance); });
const fossil = globalThis.fossil, P = JSON.parse;
const KEYS = { dl: "delta-format", af: "artifact-format", rs: "repo-state", sp: "sync-protocol" };
// Each draft is one -00 file; the revision named inside its current text.
const REVS = { dl: "00", af: "00", rs: "00", sp: "00" };
// The drafts revised in place, whose text lists its changes in an appendix.
const REVISED = new Set(["af", "rs", "sp"]);
const repo = () => new Uint8Array(fs.readFileSync(path.join(root, "rfcs/repos/rfcs.fossil")));

test("the repository opens, verifies, and every artifact matches its name", () => {
  const info = P(fossil.open("rfcs", repo()));
  assert.equal(info.projectName, "fossil-rfcs");
  assert.equal(P(fossil.verify()).ok, true);
  const names = P(fossil.nameCheck());
  assert.ok(names.length > 0);
  for (const a of names) assert.equal(a.ok, true, `${a.uuid} does not match its bytes`);
  for (const a of names.filter((x) => x.zcard)) assert.equal(a.zcard, a.zcheck, `${a.uuid}: Z card`);
});

for (const [key, name] of Object.entries(KEYS)) {
  test(`${name}: the draft is at the tip as one file carrying its current revision, with a history, and no errata`, () => {
    fossil.open(key, repo());
    const timeline = P(fossil.timeline());
    const file = `draft-fossil-${name}-00.txt`;
    const touched = timeline.filter((ci) => P(fossil.files(ci.uuid)).some((f) => f.Name === file));
    assert.ok(touched.length >= 2, "the draft has a history");
    const text = P(fossil.read(timeline[0].uuid, file)).text;
    assert.match(text, new RegExp(`draft-fossil-${name}-${REVS[key]}`));
    if (REVISED.has(key)) assert.match(text, /Changes in This Revision/, "the revised text lists its changes");
    const tip = P(fossil.files(timeline[0].uuid));
    assert.ok(!tip.some((f) => /^draft-fossil-.*-0[1-9]\.txt$/.test(f.Name)), "no revision is a separate file");
    assert.ok(!tip.some((f) => f.Name.startsWith("erratum/")), "every erratum is applied in its draft, so none remains at the tip");
  });
}

// The draft view lists a version under the oldest check-in that holds its
// text, since every later check-in of the shared repository holds it too.
// Those are the check-ins annotate names, so the inline history can find them.
for (const [key, name] of Object.entries(KEYS)) {
  test(`${name}: the check-ins annotate names are the draft's versions`, () => {
    fossil.open(key, repo());
    const timeline = P(fossil.timeline());
    const file = `draft-fossil-${name}-00.txt`;
    const versions = [];
    for (const ci of [...timeline].reverse()) {
      const f = P(fossil.files(ci.uuid)).find((x) => x.Name === file);
      if (f && !versions.some((v) => v.fileUuid === f.UUID)) versions.push({ uuid: ci.uuid, fileUuid: f.UUID });
    }
    const named = new Set(P(fossil.annotate(file, timeline[0].uuid)).map((l) => l.uuid));
    assert.ok(named.size >= 2, "annotate names more than one check-in");
    for (const uuid of named) assert.ok(versions.some((v) => v.uuid === uuid), `${uuid.slice(0, 10)} changed the draft but is not listed as a version`);
  });
}

for (const kind of ["pull", "push"]) {
  test(`a ${kind} between two copies converges`, () => {
    fossil.open("rfcs", repo());
    const s = P(fossil.syncDemo(kind));
    assert.ok(s.rounds.length >= 2);
    const ids = (side) => s.after[side].map((a) => a.uuid).sort();
    assert.deepEqual(ids("client"), ids("server"));
  });
}
