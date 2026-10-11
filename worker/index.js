// The Worker in front of the site: Fossil sync for each draft's repository,
// so a stock client can clone and pull it,
//
//   fossil clone https://illustrated-fossil-rfc.daniel-mestas.workers.dev/delta-format delta.fossil
//
// and the site's static assets for everything else. A POST to /NAME is a sync
// request against repos/NAME.fossil, answered by wasm/server/main.go: read-only,
// since each request runs against a fresh copy of the repository as published.
import "../vendor/wasm_exec.js";
import serverWasm from "./rfcserver.wasm";

// Fossil's sync payload is the compressed container; its uncompressed debug
// form is not something a client sends unasked.
const SYNC_TYPE = "application/x-fossil";
// Far above any request a clone or pull of these repositories sends.
const MAX_REQUEST_BYTES = 8 << 20;

let server = null;
const loaded = new Set();

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

const repoAsset = (name, env, method = "GET") =>
  env.ASSETS.fetch(new Request(`https://assets.invalid/repos/${name}.fossil`, { method }));

// Hand the repository's bytes, from the site's own assets, to the server.
// false when the site has no repository by that name.
async function load(name, env) {
  if (loaded.has(name)) return true;
  const res = await repoAsset(name, env);
  if (!res.ok) return false;
  check(boot().load(name, new Uint8Array(await res.arrayBuffer())));
  loaded.add(name);
  return true;
}

const text = (status, body) => new Response(body + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

async function sync(name, request, env) {
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (type !== SYNC_TYPE) return text(415, `send sync requests as ${SYNC_TYPE}`);
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_REQUEST_BYTES) return text(413, "request too large");
  if (!(await load(name, env))) return null;
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > MAX_REQUEST_BYTES) return text(413, "request too large");
  let reply;
  try {
    reply = check(boot().sync(name, body));
  } catch (e) {
    return text(400, `sync failed: ${e.message}`);
  }
  return new Response(reply, { headers: { "Content-Type": SYNC_TYPE, "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, env) {
    const name = new URL(request.url).pathname.replace(/^\/+|\/+$/g, "");
    if (/^[a-z0-9-]+$/.test(name)) {
      if (request.method === "POST") {
        const res = await sync(name, request, env);
        if (res) return res;
      } else if ((await repoAsset(name, env, "HEAD")).ok) {
        // A clone URL opened in a browser: show the site.
        return Response.redirect(new URL("/", request.url), 302);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
