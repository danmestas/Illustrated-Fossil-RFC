// Collect each draft's code literals for rfcRender's opts.codeTerms.
// The plain-text drafts lost their code markup; the kramdown sources of the
// same revision (src/*.md, dated like the .txt) still carry it as backtick
// spans. ABNF rule names from the sources' figures are literals too.
// Writes code-terms.json next to this file. Run: node code-terms.js
const fs = require("fs");
const path = require("path");
const home = process.env.HOME;
const drafts = { dl: "delta-format", af: "artifact-format", rs: "repo-state", sp: "sync-protocol" };

const dict = new Set();
try { for (const w of fs.readFileSync("/usr/share/dict/words", "utf8").split("\n")) if (w) dict.add(w.toLowerCase()); } catch {}
const core = ["ALPHA", "BIT", "CHAR", "CR", "CRLF", "CTL", "DIGIT", "DQUOTE", "HEXDIG", "HTAB", "LF", "LWSP", "OCTET", "SP", "VCHAR", "WSP"];
const req = new Set(["MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", "OPTIONAL"]);

// A literal that is one ordinary English word would mark prose: "file",
// "name", the article "A". Upper-case tokens (card letters, ABNF core rules,
// keywords like MODIFIED) are not prose words as written, so they stay.
const english = (t) => /^[A-Za-z]+$/.test(t) && (t === "A" || t === "I" || (!/^[A-Z]+$/.test(t) && dict.has(t.toLowerCase())));

function terms(md) {
  const out = new Set();
  const lines = md.split("\n");
  const prose = [];
  let fence = false;
  for (const l of lines) {
    if (/^~~~|^```/.test(l)) { fence = !fence; continue; }
    if (!fence) { prose.push(l); continue; }
    // ABNF rule lines: the defined name, and upper-case rule names used.
    const m = l.match(/^\s*([A-Za-z][A-Za-z0-9-]*)\s+=\/?\s+(.*)$/);
    if (!m) continue;
    out.add(m[1]);
    const rhs = m[2].replace(/;.*$/, "").replace(/"[^"]*"/g, " ");
    for (const r of rhs.match(/\b[A-Z][A-Z0-9-]*[A-Z0-9]\b/g) || []) out.add(r);
  }
  const text = prose.join("\n").replace(/^\s*\{:[^}]*\}\s*$/gm, "");
  // RFC 5234 core rules name bytes ("LF CR LF") even where prose leaves them unmarked.
  if (/RFC5234/.test(md)) for (const r of core) if (new RegExp(`\\b${r}\\b`).test(md)) out.add(r);
  const spanRe = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
  const coded = new Map();
  for (const m of text.matchAll(spanRe)) {
    const t = m[2].replace(/\s+/g, " ").trim();
    if (t) { out.add(t); coded.set(t, (coded.get(t) || 0) + 1); }
  }
  // Every occurrence gets marked, so a literal the prose mostly uses
  // unmarked ("payload", the article "A") is prose, not code; so is a bare
  // number or a lone punctuation mark.
  // Upper-case tokens of two or more characters (LF, OCTET, MODIFIED) are
  // protocol tokens wherever they appear.
  const plainText = text.replace(spanRe, " ").replace(/\b(Appendix|Sections?) [A-Z0-9][.0-9]*/g, " ").replace(/\s+/g, " ");
  const plain = (t) => {
    const e = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    const re = new RegExp((/^\w/.test(t) ? "(?<![\\w])" : "") + e + (/\w$/.test(t) ? "(?![\\w])" : ""), "g");
    return (plainText.match(re) || []).length;
  };
  const token = (t) => /^[A-Z][A-Z0-9-]*[A-Z0-9]$/.test(t);
  return [...out]
    .filter((t) => !/^(\d+|[^A-Za-z0-9])$/.test(t))
    .filter((t) => !english(t) && !req.has(t) && (token(t) || plain(t) <= (coded.get(t) || 0)))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

const result = {};
for (const [key, name] of Object.entries(drafts)) {
  const src = path.join(home, "fossil-rfc/src", `draft-fossil-${name}-00.md`);
  result[key] = terms(fs.readFileSync(src, "utf8"));
  console.log(`${key}: ${result[key].length} literals from ${src}`);
}
fs.writeFileSync(path.join(__dirname, "code-terms.json"), JSON.stringify(result, null, 1) + "\n");
