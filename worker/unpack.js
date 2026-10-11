// Unpack wasm/rfcserver.wasm.gz into worker/rfcserver.wasm, which
// worker/index.js imports: wrangler bundles a .wasm module, not a gzipped one.
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const root = path.join(__dirname, "..");
fs.writeFileSync(path.join(__dirname, "rfcserver.wasm"), zlib.gunzipSync(fs.readFileSync(path.join(root, "wasm", "rfcserver.wasm.gz"))));
