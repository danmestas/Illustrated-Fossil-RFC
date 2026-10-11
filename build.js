// Build the four-RFC page.
//
//   node build.js [--target worker|artifact] OUT_DIR
//
// worker (the default) writes a site for Cloudflare Workers static assets:
// index.html, the Pikchr and Go runtimes, the gzipped go-libfossil build and
// repos/rfcs.fossil. artifact writes the claude.ai artifact layout, whose
// host serves only web types: delta-format.html with every binary as base64
// text beside it.
const fs = require("fs"), zlib = require("zlib"), path = require("path"), { execFileSync } = require("child_process");
process.chdir(__dirname);
const init = require("./vendor/pikchr.js");
const rfcRender = require("./rfc-render.js");
const args = process.argv.slice(2);
const ti = args.indexOf("--target");
const TARGET = ti >= 0 ? args.splice(ti, 2)[1] : "worker";
if (!["worker", "artifact"].includes(TARGET) || args.length !== 1) {
  console.error("usage: node build.js [--target worker|artifact] OUT_DIR");
  process.exit(2);
}
const OUT = path.resolve(process.env.INIT_CWD || process.cwd(), args[0]);
const KEYS = { dl: "delta-format", af: "artifact-format", rs: "repo-state", sp: "sync-protocol" };
// The one repository the site serves: every draft and erratum (scripts/build-repo.mjs).
const REPO = "rfcs/repos/rfcs.fossil";
const STUDIO = "https://pikchr-studio.daniel-mestas.workers.dev/";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

(async () => {
  const m = await init(), m2 = m;
  const pk = m.cwrap("pikchr", "number", ["string", "string", "number", "number", "number"]);
  const render = (src, label) => {
    const p = pk(src, "pikchr", 1, 0, 0), svg = m.UTF8ToString(p); m._free(p);
    if (!svg.trimStart().startsWith("<svg")) throw new Error(label + ": " + svg);
    return svg;
  };
  const figure = (id, src, cap) => {
    const z = zlib.deflateRawSync(Buffer.from(src), { level: 9 }).toString("base64url");
    return `<figure class="pk wide" data-fig="${id}"><div class="pk-view" role="img" aria-label="${esc(cap)}"></div><pre class="pk-src">${esc(src)}</pre><figcaption class="pk-bar"><span class="cap">${esc(cap)}</span><span class="seg"><button type="button" aria-pressed="true">Diagram</button><button type="button" aria-pressed="false">Source</button></span><button type="button" class="act pk-copy">Copy source</button><a class="act" href="${STUDIO}#z=${z}" target="_blank" rel="noopener">Edit in pikchr-studio</a></figcaption></figure>`;
  };

  let html = fs.readFileSync("page.html", "utf8");
  const figs = {};

  // Delta figures (the original page).
  const DL_CAP = { worked: "B.1 · where each run of the target comes from", encoder: "§5 · one step of Fossil’s encoder", checksum: "§3.4 · the short tail counts as a zero-padded word" };
  for (const [name, cap] of Object.entries(DL_CAP)) {
    const src = fs.readFileSync(`figures/${name}.pikchr`, "utf8").trim() + "\n";
    figs[name] = { src, svg: render(src, name) };
    if (!html.includes(`<!--FIG:${name}-->`)) throw new Error("no slot " + name);
    html = html.replace(`<!--FIG:${name}-->`, () => figure(name, src, cap));
  }

  // The other RFCs' illustrated panes, figures and tools.
  let tools = "";
  for (const key of ["af", "rs", "sp"]) {
    const dir = `rfcs/${key}`;
    let frag = fs.existsSync(`${dir}/illustrated.html`) ? fs.readFileSync(`${dir}/illustrated.html`, "utf8")
      : `<header class="hero"><div class="eyebrow">draft-fossil-${KEYS[key]}-00</div><h1>${KEYS[key]}</h1><p class="lede">This reading is being written. The Draft text and Repository views are complete.</p></header>`;
    const caps = fs.existsSync(`${dir}/figures.json`) ? JSON.parse(fs.readFileSync(`${dir}/figures.json`, "utf8")) : {};
    frag = frag.replace(/<!--FIG:([\w-]+)-->/g, (_, id) => {
      const name = id.startsWith(key + "-") ? id.slice(key.length + 1) : id;
      const src = fs.readFileSync(`${dir}/d/${name}.pikchr`, "utf8").trim() + "\n";
      const fid = `${key}-${name}`;
      figs[fid] = { src, svg: render(src, fid) };
      return figure(fid, src, caps[name] || name);
    });
    const slot = `<!--ILLUS:${key}-->`;
    if (!html.includes(slot)) throw new Error("no slot " + slot);
    html = html.replace(slot, () => `  <main class="doc illus" id="illus-${key}" data-rfc="${key}" hidden>\n${frag}\n  </main>`);
    if (fs.existsSync(`${dir}/tools.js`)) tools += `\n// ---- ${key} tools ----\n` + fs.readFileSync(`${dir}/tools.js`, "utf8") + "\n";
  }

  // Draft text rendered at build time, shown until each repository opens.
  const codeTerms = JSON.parse(fs.readFileSync("rfcs/code-terms.json", "utf8"));
  const fallback = {};
  for (const [key, name] of Object.entries(KEYS)) {
    const text = execFileSync("fossil", ["cat", "-R", REPO, "-r", "trunk", `draft-fossil-${name}-00.txt`], { encoding: "utf8", maxBuffer: 1 << 26 });
    fallback[key] = rfcRender(text, { codeTerms: codeTerms[key] });
  }

  // Every grammar block marked data-abnf must yield syntax diagrams that render.
  const { railroad, pikchrMeasure } = require("./railroad.js");
  const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  let rails = 0;
  for (const m of html.matchAll(/<pre[^>]*data-abnf[^>]*>([\s\S]*?)<\/pre>/g)) {
    const g = railroad(unesc(m[1]), pikchrMeasure((s) => { const p = pk(s, "pikchr", 1, 0, 0); const o = m2.UTF8ToString(p); m2._free(p); return o; }));
    if (!g) throw new Error("data-abnf block is not ABNF: " + m[1].slice(0, 60));
    for (const r of g.rules) render(r.src, "rail " + r.name);
    rails += g.rules.length;
  }
  html = html.replace("/*FIGDATA*/", () => JSON.stringify(figs).replace(/</g, "\\u003c"));
  html = html.replace("/*CODETERMS*/", () => JSON.stringify(codeTerms).replace(/</g, "\\u003c"));
  html = html.replace("/*RFCTABLECSS*/", () => fs.readFileSync("rfcs/rfc-table.css", "utf8"));
  html = html.replace("/*FALLBACK*/", () => JSON.stringify(fallback).replace(/</g, "\\u003c"));
  html = html.replace("/*TOOLSJS*/", () => tools.replace(/<\/script/gi, "<\\/script"));
  html = html.replace("/*DELTAJS*/", () => fs.readFileSync("delta.js", "utf8").replace('if (typeof module === "object") module.exports = Delta;', "") + "\n" +
    fs.readFileSync("rfc-render.js", "utf8").replace('if (typeof module === "object") module.exports = rfcRender;', "") + "\n" +
    fs.readFileSync("railroad.js", "utf8").replace('if (typeof module === "object") module.exports = { railroad, pikchrMeasure };', ""));
  if (!html.includes('/*HOST*/"artifact"')) throw new Error("no host marker");
  html = html.replace('/*HOST*/"artifact"', () => JSON.stringify(TARGET));
  if (!html.includes('<script src="pikchr.js"></script>')) throw new Error("no pikchr script tag");
  html = html.replace('<script src="pikchr.js"></script>', '<script src="wasm_exec.js"></script>\n<script src="pikchr.js"></script>');
  for (const marker of ["/*HOST*/", "/*FIGDATA*/", "/*FALLBACK*/", "/*TOOLSJS*/", "/*DELTAJS*/", "/*CODETERMS*/", "/*RFCTABLECSS*/", "<!--ILLUS:", "<!--FIG:"]) if (html.includes(marker)) throw new Error("unfilled " + marker);

  fs.mkdirSync(OUT, { recursive: true });
  for (const f of ["pikchr.js", "pikchr.wasm", "wasm_exec.js"]) fs.copyFileSync(`vendor/${f}`, path.join(OUT, f));
  if (TARGET === "worker") {
    const doc = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + html + "</body></html>";
    fs.writeFileSync(path.join(OUT, "index.html"), doc);
    fs.copyFileSync("wasm/rfcrepo.wasm.gz", path.join(OUT, "rfcrepo.wasm.gz"));
    fs.mkdirSync(path.join(OUT, "repos"), { recursive: true });
    fs.copyFileSync(REPO, path.join(OUT, "repos", "rfcs.fossil"));
  } else {
    fs.writeFileSync(path.join(OUT, "delta-format.html"), html);
    const b64 = (f) => fs.readFileSync(f).toString("base64").replace(/.{76}/g, "$&\n");
    fs.writeFileSync(path.join(OUT, "rfcrepo-wasm-gz.txt"), b64("wasm/rfcrepo.wasm.gz"));
    fs.writeFileSync(path.join(OUT, "rfcs-fossil.txt"), b64(REPO));
  }
  console.log("built", TARGET, "into", OUT + ":", html.length, "bytes;", Object.keys(figs).length, "figures;", rails, "syntax diagrams;", tools.length, "bytes of tools");
})().catch((e) => { console.error(e.message); process.exit(1); });
