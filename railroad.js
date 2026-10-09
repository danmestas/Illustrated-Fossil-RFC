// ABNF (RFC 5234) to Pikchr syntax diagrams, in the style of the syntax
// diagrams in Pikchr's own examples: a dot starts each rule, ovals hold
// literal bytes, boxes name other rules, branches leave and rejoin the track
// on rounded corners, and a filled block ends the rule.
//
// railroad(abnf, measure) returns { src, rules } or null when the text is not
// a grammar. measure(list) takes [{ text, mono, bold }] and returns each
// text's width in inches; pass one backed by the same Pikchr build that will
// draw the result, so every box fits its text exactly.

const CORE = new Set(["ALPHA", "BIT", "CHAR", "CR", "CRLF", "CTL", "DIGIT", "DQUOTE", "HEXDIG", "HTAB", "LF", "LWSP", "OCTET", "SP", "VCHAR", "WSP"]);
const NAMED = { 0x0a: "LF", 0x0d: "CR", 0x20: "SP", 0x09: "HTAB", 0x22: "DQUOTE" };

// ---- parse --------------------------------------------------------------

function rulesOf(text) {
  const rules = [];
  const lines = text.split("\n"), cut = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  for (const raw of lines.map((l) => l.slice(cut))) {
    const whole = stripComment(raw);
    if (!whole.trim()) continue;
    // Short rules may share a line: "SP = %x20    LF = %x0A".
    // A page break can shift a whole page of rules right by a column or two.
    const start = /^ {0,3}[A-Za-z][A-Za-z0-9-]*\s*=\/?(\s|$)/.test(whole);
    const parts = start ? whole.trim().split(/\s{2,}(?=[A-Za-z][A-Za-z0-9-]*\s*=)/) : [whole];
    for (const line of parts) {
    const m = start && line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*(=\/?)\s*(.*)$/);
    if (m) rules.push({ name: m[1], inc: m[2] === "=/", body: m[3] });
    else if (!start && /^\s/.test(line) && rules.length) rules[rules.length - 1].body += " " + line.trim();
    else return null;
    }
  }
  return rules.length ? rules : null;
}

function stripComment(l) {
  let q = false;
  for (let i = 0; i < l.length; i++) {
    if (l[i] === '"') q = !q;
    else if (l[i] === ";" && !q) return l.slice(0, i).replace(/\s+$/, "");
  }
  return l.replace(/\s+$/, "");
}

function tokens(s) {
  const out = [];
  const re = /\s*(?:("[^"]*")|(%[xdb][0-9A-Fa-f]+(?:(?:\.[0-9A-Fa-f]+)+|-[0-9A-Fa-f]+)?)|(<[^>]*>)|(\d*\*\d*|\d+)|([A-Za-z][A-Za-z0-9-]*)|([()[\]\/]))/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < s.length) {
    if (/^\s*$/.test(s.slice(re.lastIndex))) break;
    const at = re.lastIndex;
    m = re.exec(s);
    if (!m || re.lastIndex === at) return null;
    if (m[1]) out.push({ k: "str", v: m[1].slice(1, -1) });
    else if (m[2]) out.push({ k: "num", v: m[2] });
    else if (m[3]) out.push({ k: "prose", v: m[3].slice(1, -1) });
    else if (m[4]) out.push({ k: "rep", v: m[4] });
    else if (m[5]) out.push({ k: "name", v: m[5] });
    else out.push({ k: m[6] });
  }
  return out;
}

function parse(body, self) {
  if (/[A-Za-z0-9]\(/.test(body)) return null; // a function call, not ABNF
  const ts = tokens(body);
  if (!ts) return null;
  let i = 0;
  const peek = () => ts[i] && ts[i].k;
  function alt() {
    const items = [seq()];
    while (peek() === "/") { i++; items.push(seq()); }
    return items.length === 1 ? items[0] : { t: "alt", items };
  }
  function seq() {
    const items = [];
    while (i < ts.length && !["/", ")", "]"].includes(peek())) items.push(rep());
    if (!items.length) throw new Error("empty sequence");
    return items.length === 1 ? items[0] : { t: "seq", items };
  }
  function rep() {
    if (peek() !== "rep") return elem();
    const r = ts[i++].v, e = elem();
    if (!r.includes("*")) return { t: "rep", item: e, min: +r, max: +r };
    const [a, b] = r.split("*");
    const min = a === "" ? 0 : +a, max = b === "" ? Infinity : +b;
    const loop = { t: "rep", item: e, min: Math.max(min, 1), max };
    return min === 0 ? { t: "opt", item: loop } : loop;
  }
  function elem() {
    const t = ts[i++];
    if (!t) throw new Error("unexpected end");
    if (t.k === "(") { const a = alt(); if (ts[i++]?.k !== ")") throw new Error("missing )"); return a; }
    if (t.k === "[") { const a = alt(); if (ts[i++]?.k !== "]") throw new Error("missing ]"); return { t: "opt", item: a }; }
    if (t.k === "str") return { t: "term", text: t.v === "" ? '""' : /\s/.test(t.v) || t.v.length === 0 ? `"${t.v}"` : t.v };
    if (t.k === "num") { const h = hexText(t.v); return { t: "term", text: h === self ? t.v : h }; }
    if (t.k === "prose") return { t: "nt", text: t.v };
    if (t.k === "name") return CORE.has(t.v) ? { t: "term", text: t.v } : { t: "nt", text: t.v };
    throw new Error("unexpected " + t.k);
  }
  try {
    const a = alt();
    return i === ts.length ? a : null;
  } catch { return null; }
}

function hexText(v) {
  const base = { x: 16, d: 10, b: 2 }[v[1]];
  const body = v.slice(2);
  const show = (n) => NAMED[n] || (n > 0x20 && n < 0x7f ? String.fromCharCode(n) : v[0] + v[1] + n.toString(base).toUpperCase().padStart(2, "0"));
  if (body.includes("-")) {
    const [a, b] = body.split("-").map((x) => parseInt(x, base));
    const pa = a > 0x20 && a < 0x7f, pb = b > 0x20 && b < 0x7f;
    return pa && pb ? `${show(a)}–${show(b)}` : v;
  }
  return body.split(".").map((x) => show(parseInt(x, base))).join(" ");
}

// ---- layout -------------------------------------------------------------

const H = 0.3;      // shape height
const R = 0.12;     // corner radius and branch inset
const G = 0.17;     // gap between items in a row
const V = 0.14;     // clearance between stacked branches
const PADT = 0.26;  // padding around a terminal's text
const PADN = 0.26;  // padding around a rule name's text

const f3 = (n) => (Math.round(n * 1000) / 1000).toString();
const pt = (x, y) => `(${f3(x)},${f3(y)})`;
const q = (s) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

function size(n, W) {
  switch (n.t) {
    case "term": case "nt": {
      n.w = W.get(key(n)) + (n.t === "term" ? PADT : PADN);
      n.up = n.down = H / 2;
      break;
    }
    case "seq": {
      n.items.forEach((c) => size(c, W));
      n.w = n.items.reduce((s, c) => s + c.w, 0) + G * (n.items.length - 1);
      n.up = Math.max(...n.items.map((c) => c.up));
      n.down = Math.max(...n.items.map((c) => c.down));
      break;
    }
    case "alt": {
      n.items.forEach((c) => size(c, W));
      n.w = Math.max(...n.items.map((c) => c.w)) + 4 * R;
      n.up = n.items[0].up;
      n.offs = [0];
      let d = n.items[0].down;
      for (const c of n.items.slice(1)) {
        const o = d + V + Math.max(c.up, R);
        n.offs.push(Math.max(o, 2 * R));
        d = n.offs[n.offs.length - 1] + c.down;
      }
      n.down = d;
      break;
    }
    case "opt": {
      size(n.item, W);
      n.w = n.item.w + 4 * R;
      n.up = n.item.up;
      n.skip = Math.max(n.item.down + V, 2 * R);
      n.down = n.skip;
      break;
    }
    case "rep": {
      size(n.item, W);
      n.note = n.min === n.max ? (n.min === 1 ? "" : `${n.min} times`)
        : n.max === Infinity ? (n.min > 1 ? `${n.min} or more` : "")
        : `${n.min} to ${n.max}`;
      if (n.min === n.max && n.min > 1 && (n.item.t === "term" || n.item.t === "nt")) {
        // A fixed count of one shape: the shape with its count beneath.
        n.fixed = true;
        n.w = Math.max(n.item.w, W.get("note:" + n.note) || 0);
        n.up = n.item.up;
        n.down = n.item.down + 0.22;
      } else {
        n.w = n.item.w + 4 * R;
        n.up = n.item.up;
        n.loop = Math.max(n.item.down + V, 2 * R);
        n.down = n.loop + (n.note ? 0.22 : 0);
      }
      break;
    }
  }
  return n;
}

const key = (n) => (n.t === "term" ? "m:" : "n:") + n.text;
const startsWithShape = (n) => n.t === "term" || n.t === "nt" || (n.t === "seq" && startsWithShape(n.items[0])) || (n.t === "rep" && n.fixed);

// draw(n, x, y, out): track enters at (x, y) and leaves at (x + n.w, y).
function draw(n, x, y, out) {
  switch (n.t) {
    case "term":
      out.push(`oval ${q(n.text)} mono wid ${f3(n.w)} ht ${H} at ${pt(x + n.w / 2, y)}`);
      break;
    case "nt":
      out.push(`box ${q(n.text)} wid ${f3(n.w)} ht ${H} rad 0.04 at ${pt(x + n.w / 2, y)}`);
      break;
    case "seq": {
      let cx = x;
      n.items.forEach((c, i) => {
        if (i) {
          out.push(`${startsWithShape(c) ? "arrow" : "line"} from ${pt(cx, y)} to ${pt(cx + G, y)}`);
          cx += G;
        }
        draw(c, cx, y, out);
        cx += c.w;
      });
      break;
    }
    case "alt": {
      const ix = x + 2 * R;
      n.items.forEach((c, i) => {
        const yy = y - n.offs[i];
        const head = startsWithShape(c) ? " ->" : "";
        if (i === 0) out.push(`line from ${pt(x, y)} to ${pt(ix, y)}${head}`);
        else out.push(`line from ${pt(x, y)} right ${R} then down ${f3(n.offs[i])} then right ${R}${head}`);
        draw(c, ix, yy, out);
        const ex = ix + c.w;
        if (i === 0) out.push(`line from ${pt(ex, y)} to ${pt(x + n.w, y)}`);
        else out.push(`line from ${pt(ex, yy)} right ${f3(x + n.w - R - ex)} then up ${f3(n.offs[i])} then right ${R}`);
      });
      break;
    }
    case "opt": {
      const ix = x + 2 * R;
      out.push(`line from ${pt(x, y)} to ${pt(ix, y)}${startsWithShape(n.item) ? " ->" : ""}`);
      draw(n.item, ix, y, out);
      out.push(`line from ${pt(ix + n.item.w, y)} to ${pt(x + n.w, y)}`);
      out.push(`line from ${pt(x, y)} right ${R} then down ${f3(n.skip)} then right ${f3(n.w - 2 * R)} then up ${f3(n.skip)} then right ${R}`);
      break;
    }
    case "rep": {
      if (n.fixed) {
        const ix = x + (n.w - n.item.w) / 2;
        if (ix > x) out.push(`line from ${pt(x, y)} to ${pt(ix, y)}`);
        draw(n.item, ix, y, out);
        if (ix > x) out.push(`line from ${pt(ix + n.item.w, y)} to ${pt(x + n.w, y)}`);
        out.push(`text ${q(n.note)} small at ${pt(x + n.w / 2, y - n.item.down - 0.12)}`);
        break;
      }
      const ix = x + 2 * R, ex = ix + n.item.w;
      out.push(`line from ${pt(x, y)} to ${pt(ix, y)}${startsWithShape(n.item) ? " ->" : ""}`);
      draw(n.item, ix, y, out);
      out.push(`line from ${pt(ex, y)} to ${pt(x + n.w, y)}`);
      out.push(`arrow from ${pt(ex, y)} right ${R} then down ${f3(n.loop)} then left ${f3(n.item.w + 2 * R)} then up ${f3(n.loop)} then right ${R}`);
      if (n.note) out.push(`text ${q(n.note)} small at ${pt(x + n.w / 2, y - n.loop - 0.16)}`);
      break;
    }
  }
}

// A rule too wide for the column wraps its top-level sequence into rows.
function rows(node, maxW) {
  if (node.w <= maxW || node.t !== "seq") return [node];
  const out = [];
  let cur = [], w = 0;
  for (const c of node.items) {
    const add = (cur.length ? G : 0) + c.w;
    if (cur.length && w + add > maxW) { out.push(cur); cur = []; w = 0; }
    w += (cur.length ? G : 0) + c.w;
    cur.push(c);
  }
  out.push(cur);
  return out.map((items) => {
    if (items.length === 1) return items[0];
    const s = { t: "seq", items };
    s.w = items.reduce((a, c) => a + c.w, 0) + G * (items.length - 1);
    s.up = Math.max(...items.map((c) => c.up));
    s.down = Math.max(...items.map((c) => c.down));
    return s;
  });
}

function railroad(abnf, measure, opts = {}) {
  const rules = rulesOf(abnf);
  if (!rules) return null;
  // "=/" adds alternatives to an earlier rule.
  const merged = [];
  for (const r of rules) {
    const prev = r.inc && merged.find((m) => m.name === r.name);
    if (prev) prev.body = `( ${prev.body} ) / ( ${r.body} )`;
    else merged.push({ name: r.name, body: r.body });
  }
  for (const r of merged) if (!(r.node = parse(r.body, r.name))) return null;

  const want = new Map();
  const walk = (n) => {
    if (n.t === "term") want.set(key(n), { text: n.text, mono: true });
    else if (n.t === "nt") want.set(key(n), { text: n.text });
    if (n.items) n.items.forEach(walk);
    if (n.item) walk(n.item);
    if (n.t === "rep") for (const s of [`${n.min} times`, `${n.min} or more`, `${n.min} to ${n.max}`]) want.set("note:" + s, { text: s, small: true });
  };
  merged.forEach((r) => { walk(r.node); want.set("r:" + r.name, { text: r.name, bold: true }); });
  const keys = [...want.keys()], widths = measure(keys.map((k) => want.get(k)));
  const W = new Map(keys.map((k, i) => [k, widths[i]]));

  const maxW = opts.maxWidth || 6.2;
  const LEAD = 0.3, TAIL = 0.3; // dot to first item, last item to end block
  const HEAD = ["linerad = " + R, "arrowht = 0.08", "arrowwid = 0.06"];
  // One rule laid out with its name right-aligned in a gutter ending at X0,
  // the track starting at height y. Returns the lowest y it drew to.
  function rule(r, X0, y, out) {
    size(r.node, W);
    const rs = rows(r.node, maxW - X0 - LEAD - TAIL - 2 * R);
    out.push(`text ${q(r.name)} bold rjust at ${pt(X0 - 0.1, y)}`);
    out.push(`dot at ${pt(X0, y)} rad 0.035`);
    let x = X0;
    rs.forEach((row, i) => {
      if (i === 0) {
        out.push(`${startsWithShape(row) ? "arrow" : "line"} from ${pt(X0, y)} to ${pt(X0 + LEAD, y)}`);
        x = X0 + LEAD;
      }
      draw(row, x, y, out);
      x += row.w;
      if (i < rs.length - 1) {
        // Down the right side, back along the bottom, into the next row.
        const next = rs[i + 1];
        const drop = row.down + V + 0.08;
        const ny = y - drop - Math.max(next.up, R) - V;
        out.push(`line from ${pt(x, y)} right ${R} then down ${f3(drop)} then left ${f3(x + R - X0 - LEAD + 2 * R)} then down ${f3(y - drop - ny)} then right ${f3(2 * R)}${startsWithShape(next) ? " ->" : ""}`);
        y = ny;
        x = X0 + LEAD;
      }
    });
    out.push(`arrow from ${pt(x, y)} to ${pt(x + TAIL, y)}`);
    out.push(`box wid 0.05 ht ${f3(H * 0.6)} fill black at ${pt(x + TAIL + 0.025, y)}`);
    return y - rs[rs.length - 1].down;
  }
  // Each rule on its own, gutter sized to its own name.
  const each = merged.map((r) => {
    const out = [...HEAD];
    rule(r, W.get("r:" + r.name) + 0.2, 0, out);
    return { name: r.name, src: out.join("\n") + "\n" };
  });
  // All rules stacked, sharing one gutter: the source a reader copies or edits.
  const X0 = Math.max(...merged.map((r) => W.get("r:" + r.name))) + 0.2;
  const out = [...HEAD];
  let y = 0;
  merged.forEach((r, k) => {
    if (k) { size(r.node, W); y -= Math.max(rows(r.node, maxW - X0 - LEAD - TAIL - 2 * R)[0].up, H / 2) + 0.2; }
    y = rule(r, X0, y, out);
  });
  return { src: out.join("\n") + "\n", rules: each };
}

// A measure() backed by a Pikchr renderer: render(src) returns its output.
function pikchrMeasure(render) {
  const cache = new Map();
  return (list) => {
    const miss = list.filter((t) => !cache.has(JSON.stringify(t)));
    if (miss.length) {
      const src = miss.map((t, i) => `T${i}: text ${q(t.text)}${t.mono ? " mono" : ""}${t.bold ? " bold" : ""}${t.small ? " small" : ""} fit\nprint T${i}.wid`).join("\n");
      const nums = render(src).split("<br>").slice(0, miss.length).map((s) => parseFloat(s));
      miss.forEach((t, i) => cache.set(JSON.stringify(t), nums[i]));
    }
    return list.map((t) => cache.get(JSON.stringify(t)));
  };
}

if (typeof module === "object") module.exports = { railroad, pikchrMeasure };
