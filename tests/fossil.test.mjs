// The go-libfossil build the page runs, against the four repositories it ships.
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

for (const [key, name] of Object.entries(KEYS)) {
  test(`${name}: opens, verifies, and every artifact matches its name`, () => {
    const info = P(fossil.open(key, new Uint8Array(fs.readFileSync(path.join(root, `rfcs/repos/${key}.fossil`)))));
    assert.equal(info.projectName, `draft-fossil-${name}`);
    assert.equal(P(fossil.verify()).ok, true);
    const timeline = P(fossil.timeline());
    assert.ok(timeline.length >= 2, "the draft has a history");
    const names = P(fossil.nameCheck());
    assert.ok(names.length > 0);
    for (const a of names) assert.equal(a.ok, true, `${a.uuid} does not match its bytes`);
    for (const a of names.filter((x) => x.zcard)) assert.equal(a.zcard, a.zcheck, `${a.uuid}: Z card`);
  });
}

for (const kind of ["pull", "push"]) {
  test(`a ${kind} between two copies converges`, () => {
    fossil.open("sp", new Uint8Array(fs.readFileSync(path.join(root, "rfcs/repos/sp.fossil"))));
    const s = P(fossil.syncDemo(kind));
    assert.ok(s.rounds.length >= 2);
    const ids = (side) => s.after[side].map((a) => a.uuid).sort();
    assert.deepEqual(ids("client"), ids("server"));
  });
}
