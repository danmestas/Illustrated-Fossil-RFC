// The Worker in front of the site: each draft's repository as a Fossil
// server, so a stock client can clone, pull and push it,
//
//   fossil clone https://illustrated-fossil-rfc.daniel-mestas.workers.dev/delta-format delta.fossil
//
// and the site's static assets for everything else.
//
// One Durable Object per draft holds its repository: it starts as the copy
// the site publishes (repos/NAME.fossil among the assets), and keeps every
// check-in pushed to it since. A POST to /NAME is a sync request, answered
// against that copy by wasm/server/main.go; GET /repos/NAME.fossil serves the
// copy, so the page's Repository view and its download show what was pushed.
// The copy holds no login: the accounts that may push are the Worker secret
// FOSSIL_PUSHERS, one "login:password" per line, given to each sync call.
import { DurableObject } from "cloudflare:workers";
import "../vendor/wasm_exec.js";
import serverWasm from "./rfcserver.wasm";

// Fossil's sync payload is the compressed container; its uncompressed debug
// form is not something a client sends unasked.
const SYNC_TYPE = "application/x-fossil";
// Far above any request a clone, pull or push of these drafts sends.
const MAX_REQUEST_BYTES = 8 << 20;
// Durable Object storage keeps values up to 2 MiB; the repository is stored
// in chunks well under that.
const CHUNK_BYTES = 1 << 20;

let server = null;

// Go's runtime runs main() to its final select{} inside go.run, so the API is
// in place as soon as run returns: no promise has to outlive the request that
// started the program.
function boot() {
  if (server) return server;
  const go = new Go();
  go.run(new WebAssembly.Instance(serverWasm, go.importObject));
  if (!globalThis.fossilServer) throw new Error("the sync server did not start");
  return (server = globalThis.fossilServer);
}

function check(result) {
  if (result && typeof result === "object" && "error" in result) throw new Error(result.error);
  return result;
}

const text = (status, body) => new Response(body + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

const repoAsset = (name, env, method = "GET") =>
  env.ASSETS.fetch(new Request(`https://assets.invalid/repos/${name}.fossil`, { method }));

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class FossilRepo extends DurableObject {
  // The repository's bytes as stored, and the digest of the published copy
  // they last took in. Read once per instance.
  #bytes = null;
  #seed = null;

  async #read() {
    const meta = await this.ctx.storage.get("meta");
    if (!meta) return null;
    const parts = await this.ctx.storage.get(Array.from({ length: meta.chunks }, (_, i) => `chunk:${i}`));
    const out = new Uint8Array(meta.size);
    let at = 0;
    for (let i = 0; i < meta.chunks; i++) {
      const part = parts.get(`chunk:${i}`);
      out.set(part, at);
      at += part.length;
    }
    if (at !== meta.size) throw new Error("the stored repository is incomplete");
    return { bytes: out, seed: meta.seed };
  }

  async #write(bytes, seed) {
    const entries = {};
    let chunks = 0;
    for (let at = 0; at < bytes.length; at += CHUNK_BYTES) entries[`chunk:${chunks++}`] = bytes.subarray(at, at + CHUNK_BYTES);
    const old = await this.ctx.storage.get("meta");
    entries.meta = { size: bytes.length, chunks, seed };
    await this.ctx.storage.put(entries);
    if (old && old.chunks > chunks) {
      await this.ctx.storage.delete(Array.from({ length: old.chunks - chunks }, (_, i) => `chunk:${chunks + i}`));
    }
    this.#bytes = bytes;
    this.#seed = seed;
  }

  // The repository, after taking in whatever the published copy has that it
  // lacks. Each deployment checks once per instance; a release that changes
  // the published copy merges it in once.
  async #repo(name) {
    if (this.#bytes) return this.#bytes;
    const res = await repoAsset(name, this.env);
    if (!res.ok) throw new Error(`no published repository named ${name}`);
    const published = new Uint8Array(await res.arrayBuffer());
    const seed = await sha256(published);
    const stored = await this.#read();
    if (!stored) {
      await this.#write(published, seed);
    } else if (stored.seed !== seed) {
      const merged = check(boot().merge(stored.bytes, published));
      await this.#write(merged || stored.bytes, seed);
    } else {
      this.#bytes = stored.bytes;
      this.#seed = stored.seed;
    }
    return this.#bytes;
  }

  async fetch(request) {
    const name = request.headers.get("X-Fossil-Repo");
    const repo = await this.#repo(name);
    if (request.method !== "POST") {
      return new Response(repo, { headers: { "Content-Type": "application/x-fossil-repository", "Cache-Control": "no-store" } });
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > MAX_REQUEST_BYTES) return text(413, "request too large");
    let result;
    try {
      result = check(boot().sync(repo, body, this.env.FOSSIL_PUSHERS || ""));
    } catch (e) {
      return text(400, `sync failed: ${e.message}`);
    }
    if (result.repo) await this.#write(result.repo, this.#seed);
    return new Response(result.reply, { headers: { "Content-Type": SYNC_TYPE, "Cache-Control": "no-store" } });
  }
}

// Hand the request to the draft's Durable Object, naming the draft.
function toRepo(name, request, env) {
  const stub = env.REPO.get(env.REPO.idFromName(name));
  const headers = new Headers(request.headers);
  headers.set("X-Fossil-Repo", name);
  return stub.fetch(new Request(request, { headers }));
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    // The page's Repository view and its download: the repository as it is now.
    const file = path.match(/^\/repos\/([a-z0-9-]+)\.fossil$/);
    if (file && request.method === "GET") {
      if (!(await repoAsset(file[1], env, "HEAD")).ok) return env.ASSETS.fetch(request);
      return toRepo(file[1], request, env);
    }
    const name = path.replace(/^\/+|\/+$/g, "");
    if (/^[a-z0-9-]+$/.test(name) && (await repoAsset(name, env, "HEAD")).ok) {
      if (request.method !== "POST") {
        // A clone URL opened in a browser: show the site.
        return Response.redirect(new URL("/", request.url), 302);
      }
      const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      if (type !== SYNC_TYPE) return text(415, `send sync requests as ${SYNC_TYPE}`);
      if (Number(request.headers.get("Content-Length") || 0) > MAX_REQUEST_BYTES) return text(413, "request too large");
      return toRepo(name, request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
