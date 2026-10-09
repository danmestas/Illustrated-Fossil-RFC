// The JavaScript port of Fossil's delta codec the playground runs.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const Delta = createRequire(import.meta.url)("../delta.js");
const enc = new TextEncoder();

test("the draft's worked example decodes", () => {
  const src = enc.encode("The quick brown fox jumps over the lazy dog. A Fossil delta\n");
  const tgt = enc.encode("The quick brown fox jumps over the sleeping fox. A Fossil delta\n");
  const d = Delta.create(src, tgt).bytes;
  const r = Delta.apply(src, d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.out, tgt);
});

test("create and apply round-trip random pairs", () => {
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
  for (let i = 0; i < 200; i++) {
    const src = Uint8Array.from({ length: rnd(3000) }, () => rnd(i % 2 ? 256 : 26) + (i % 2 ? 0 : 97));
    const tgt = new Uint8Array([...src.subarray(rnd(src.length + 1)), ...Uint8Array.from({ length: rnd(400) }, () => rnd(256)), ...src.subarray(0, rnd(src.length + 1))]);
    const r = Delta.apply(src, Delta.create(src, tgt).bytes);
    assert.equal(r.ok, true, `pair ${i}: ${r.message}`);
    assert.deepEqual(r.out, tgt);
  }
});

test("a delta with no trailer is rejected", () => {
  assert.notEqual(Delta.apply(enc.encode("abc"), enc.encode("3\n3:abc")).ok, true);
});
