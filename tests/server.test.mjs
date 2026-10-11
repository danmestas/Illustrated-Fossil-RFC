// The sync server the Worker runs (wasm/server/main.go), against stock fossil.
// A plain Node HTTP server stands in for the Worker and its Durable Objects:
// it keeps each repository's bytes and hands every POST body to the same
// fossilServer.sync call worker/index.js makes, storing the bytes it returns.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import "../vendor/wasm_exec.js";

// fossil refuses to clone or commit without knowing who is acting, and a CI
// runner's environment may carry no USER.
const execFossil = promisify(execFile);
const run = (cmd, args, opts = {}) => execFossil(cmd, args, { ...opts, env: { ...process.env, USER: process.env.USER || "ci" } });
const root = path.join(import.meta.dirname, "..");
const KEYS = { dl: "delta-format", af: "artifact-format", rs: "repo-state", sp: "sync-protocol" };
const repoFile = (key) => path.join(root, `rfcs/repos/${key}.fossil`);
const sql = async (repo, query) => (await run("fossil", ["sqlite3", "-R", repo, query])).stdout.trim();
const artifacts = (repo) => sql(repo, "SELECT group_concat(uuid) FROM (SELECT uuid FROM blob WHERE size>=0 ORDER BY uuid)");
const PUSHERS = "editor:a-test-password\n";

const go = new globalThis.Go();
const wasm = zlib.gunzipSync(fs.readFileSync(path.join(root, "wasm/rfcserver.wasm.gz")));
go.run((await WebAssembly.instantiate(wasm, go.importObject)).instance);
const server = globalThis.fossilServer;
const check = (r) => { if (r && r.error) throw new Error(r.error); return r; };

test("no account can log in to a shipped repository", async () => {
  for (const key of Object.keys(KEYS)) {
    assert.equal(await sql(repoFile(key), "SELECT count(*) FROM user WHERE login<>'nobody' AND (pw<>'' OR cap<>'')"), "0", key);
    assert.doesNotMatch(await sql(repoFile(key), "SELECT cap FROM user WHERE login='nobody'"), /[ais]/, `${key}: nobody can push`);
  }
});

test("stock fossil clones every repository, pushes only with an account, and the push persists", async (t) => {
  const repos = new Map(Object.entries(KEYS).map(([key, name]) => [name, new Uint8Array(fs.readFileSync(repoFile(key)))]));
  const httpServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const name = req.url.slice(1);
      const result = server.sync(repos.get(name), new Uint8Array(Buffer.concat(chunks)), PUSHERS);
      if (result.error) { res.writeHead(400).end(result.error); return; }
      if (result.repo) repos.set(name, result.repo);
      res.writeHead(200, { "Content-Type": "application/x-fossil" }).end(Buffer.from(result.reply));
    });
  });
  await new Promise((ready) => httpServer.listen(0, "127.0.0.1", ready));
  t.after(() => httpServer.close());
  const host = `127.0.0.1:${httpServer.address().port}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ifr-server-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  for (const [key, name] of Object.entries(KEYS)) {
    const clone = path.join(work, `${name}.fossil`);
    await run("fossil", ["clone", "-q", `http://${host}/${name}`, clone]);
    assert.equal(await artifacts(clone), await artifacts(repoFile(key)), `${name}: the clone holds every artifact`);
  }

  const checkout = path.join(work, "checkout");
  fs.mkdirSync(checkout);
  await run("fossil", ["open", path.join(work, "delta-format.fossil")], { cwd: checkout });
  await run("fossil", ["settings", "autosync", "off"], { cwd: checkout });
  fs.appendFileSync(path.join(checkout, "draft-fossil-delta-format-00.txt"), "a pushed edit\n");
  await run("fossil", ["commit", "-m", "a pushed edit", "--user-override", "editor", "--no-warnings"], { cwd: checkout });
  const output = (r) => `${r.stdout}${r.stderr}`;
  assert.match(output(await run("fossil", ["push", `http://${host}/delta-format`], { cwd: checkout }).catch((e) => e)), /push denied/);
  assert.match(output(await run("fossil", ["push", `http://editor:wrong@${host}/delta-format`], { cwd: checkout }).catch((e) => e)), /login failed/);
  assert.match(output(await run("fossil", ["push", `http://editor:a-test-password@${host}/delta-format`], { cwd: checkout })), /Artifacts sent: [1-9]/);
  await run("fossil", ["close", "--force"], { cwd: checkout });

  const fresh = path.join(work, "fresh.fossil");
  await run("fossil", ["clone", "-q", `http://${host}/delta-format`, fresh]);
  assert.equal(await sql(fresh, "SELECT count(*) FROM event WHERE type='ci' AND comment='a pushed edit'"), "1", "a fresh clone has the pushed check-in");

  const stored = path.join(work, "stored.fossil");
  fs.writeFileSync(stored, repos.get("delta-format"));
  assert.equal(await sql(stored, "SELECT count(*) FROM user WHERE pw<>'' OR (cap<>'' AND login<>'nobody')"), "0", "the stored repository holds no login");

  // A release publishing a repository the stored one lacks artifacts of merges them in.
  const merged = check(server.merge(new Uint8Array(fs.readFileSync(repoFile("dl"))), repos.get("delta-format")));
  assert.ok(merged, "the merge took in the pushed check-in");
  fs.writeFileSync(stored, merged);
  assert.equal(await artifacts(stored), await artifacts(fresh));
  assert.equal(check(server.merge(merged, new Uint8Array(fs.readFileSync(repoFile("dl"))))), null, "nothing new merges as nothing");
});
