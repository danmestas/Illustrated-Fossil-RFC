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
const REVS = { dl: "00", af: "01", rs: "01", sp: "01" };
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
  test(`${name}: the draft is at the tip, with a history, and the -00 text and its errata beside it`, () => {
    fossil.open(key, repo());
    const timeline = P(fossil.timeline());
    const file = `draft-fossil-${name}-${REVS[key]}.txt`;
    const touched = timeline.filter((ci) => P(fossil.files(ci.uuid)).some((f) => f.Name === file));
    assert.ok(touched.length >= (REVS[key] === "00" ? 2 : 1), "the draft has a history");
    const text = P(fossil.read(timeline[0].uuid, file)).text;
    assert.match(text, new RegExp(`draft-fossil-${name}-${REVS[key]}`));
    if (REVS[key] === "01") assert.match(text, new RegExp(`Changes from draft-fossil-${name}-00`), "the -01 text lists its changes");
    const tip = P(fossil.files(timeline[0].uuid));
    assert.ok(tip.some((f) => f.Name === `draft-fossil-${name}-00.txt`), "the -00 text stays beside it");
    const errata = tip.filter((f) => f.Name.startsWith(`erratum/${name}-`));
    for (const e of errata) assert.match(P(fossil.read(timeline[0].uuid, e.Name)).text, /^# (Technical )?[Ee]rratum/);
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
