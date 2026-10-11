// The sync server the Worker runs (wasm/server/main.go), against stock fossil:
// every repository clones whole, and a push is refused. A plain Node HTTP
// server stands in for the Worker, handing each POST body to the same
// fossilServer.sync call worker/index.js makes.
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

const run = promisify(execFile);
const root = path.join(import.meta.dirname, "..");
const KEYS = { dl: "delta-format", af: "artifact-format", rs: "repo-state", sp: "sync-protocol" };
const repoFile = (key) => path.join(root, `rfcs/repos/${key}.fossil`);
const sql = async (repo, query) => (await run("fossil", ["sqlite3", "-R", repo, query])).stdout.trim();

test("no account can log in to a shipped repository", async () => {
  for (const key of Object.keys(KEYS)) {
    assert.equal(await sql(repoFile(key), "SELECT count(*) FROM user WHERE login<>'nobody' AND (pw<>'' OR cap<>'')"), "0", key);
    assert.doesNotMatch(await sql(repoFile(key), "SELECT cap FROM user WHERE login='nobody'"), /[ais]/, `${key}: nobody can push`);
  }
});

test("stock fossil clones every repository from the sync server, and cannot push", async (t) => {
  const go = new globalThis.Go();
  const wasm = zlib.gunzipSync(fs.readFileSync(path.join(root, "wasm/rfcserver.wasm.gz")));
  const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
  go.run(instance);
  const server = globalThis.fossilServer;
  for (const [key, name] of Object.entries(KEYS)) server.load(name, new Uint8Array(fs.readFileSync(repoFile(key))));

  const httpServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const reply = server.sync(req.url.slice(1), new Uint8Array(Buffer.concat(chunks)));
      if (reply.error) { res.writeHead(400).end(reply.error); return; }
      res.writeHead(200, { "Content-Type": "application/x-fossil" }).end(Buffer.from(reply));
    });
  });
  await new Promise((ready) => httpServer.listen(0, "127.0.0.1", ready));
  t.after(() => httpServer.close());
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ifr-server-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  const artifacts = (repo) => sql(repo, "SELECT group_concat(uuid) FROM (SELECT uuid FROM blob WHERE size>=0 ORDER BY uuid)");
  for (const [key, name] of Object.entries(KEYS)) {
    const clone = path.join(work, `${name}.fossil`);
    await run("fossil", ["clone", "-q", `${base}/${name}`, clone]);
    assert.equal(await artifacts(clone), await artifacts(repoFile(key)), `${name}: the clone holds every artifact`);
  }

  const checkout = path.join(work, "checkout");
  fs.mkdirSync(checkout);
  await run("fossil", ["open", path.join(work, "delta-format.fossil")], { cwd: checkout });
  fs.appendFileSync(path.join(checkout, "draft-fossil-delta-format-00.txt"), "a local edit\n");
  await run("fossil", ["commit", "-m", "a local edit", "--no-warnings"], { cwd: checkout });
  const push = await run("fossil", ["push", `${base}/delta-format`], { cwd: checkout }).catch((e) => e);
  assert.match(`${push.stdout}${push.stderr}`, /push denied/);
  await run("fossil", ["close", "--force"], { cwd: checkout });
});
