// Both build targets complete and carry what each host needs.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = path.join(import.meta.dirname, "..");
const build = (target) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `ifr-${target}-`));
  execFileSync("node", [path.join(root, "build.js"), "--target", target, out], { stdio: "pipe" });
  return out;
};

test("the worker build serves the binaries as they are", () => {
  const out = build("worker");
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /const HOST = "worker";/);
  for (const f of ["pikchr.js", "pikchr.wasm", "wasm_exec.js", "rfcrepo.wasm.gz",
    "repos/rfcs.fossil"]) {
    assert.ok(fs.statSync(path.join(out, f)).size > 0, f);
  }
  // Workers static assets refuse files over 25 MiB.
  for (const f of fs.readdirSync(out, { recursive: true })) assert.ok(fs.statSync(path.join(out, f)).size < 25 * 1024 * 1024, f);
  fs.rmSync(out, { recursive: true });
});

test("the artifact build ships every binary as base64 text", () => {
  const out = build("artifact");
  const html = fs.readFileSync(path.join(out, "delta-format.html"), "utf8");
  assert.match(html, /const HOST = "artifact";/);
  for (const f of ["rfcrepo-wasm-gz.txt", "rfcs-fossil.txt"]) {
    assert.match(fs.readFileSync(path.join(out, f), "utf8").slice(0, 200), /^[A-Za-z0-9+/=\n]+$/);
  }
  fs.rmSync(out, { recursive: true });
});

test("the page's scripts parse", () => {
  const out = build("worker");
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(js.length >= 2);
  for (const s of js) assert.doesNotThrow(() => new Function(s));
  fs.rmSync(out, { recursive: true });
});
