// Render the plain-text draft as HTML. Words are the draft's own; only markup is
// added. Every rendered block carries data-ln="first-last", its source line
// numbers (1-based), so per-line history (annotate) can be laid over it.
// Runs in Node at build time and in the browser.
// opts.codeTerms lists literals (longest first) to set in <code>.
function rfcRender(text, opts = {}) {
  const raw = text.split("\n");
  if (raw.length && raw[raw.length - 1] === "") raw.pop();

  // Drop page footers and headers; remember where pages broke.
  const lines = [], nums = [], breaks = new Set();
  for (let i = 0; i < raw.length; i++) {
    if (/^Hipp, et al\.\s+Expires .*\[Page \d+\]$/.test(raw[i])) {
      while (lines.length && lines[lines.length - 1].trim() === "") { lines.pop(); nums.pop(); }
      i++; while (i < raw.length && raw[i].trim() === "") i++;
      if (/^Internet-Draft\s{2,}\S.*\s{2,}\w+ \d{4}$/.test(raw[i])) i++;
      while (i + 1 < raw.length && raw[i + 1].trim() === "") i++;
      breaks.add(lines.length); continue;
    }
    lines.push(raw[i]); nums.push(i + 1);
  }

  // Blocks are separated by blank lines; a page break joins a block cut mid-sentence.
  const blocks = []; let cur = null;
  const flush = () => { if (cur && cur.lines.length) blocks.push(cur); cur = null; };
  for (let i = 0; i < lines.length; i++) {
    if (breaks.has(i) && cur) {
      const last = cur.lines[cur.lines.length - 1].trim(), next = lines[i].trim();
      const heading = cur.lines.length === 1 && /^(\d+(\.\d+)*|Appendix [A-Z]|[A-Z](\.\d+)+)\.\s{2}\S|^ +Table \d+$/.test(cur.lines[0]);
      const cut = !heading && (!/[.:;)\]]$/.test(last) || /^[a-z(]/.test(next)) && /^\s{3}\S/.test(lines[i]);
      if (!cut) flush();
    }
    if (lines[i].trim() === "") { flush(); continue; }
    (cur ||= { lines: [], nums: [] }).lines.push(lines[i]); cur.nums.push(nums[i]);
  }
  flush();

  const headRe = /^(?:(\d+(?:\.\d+)*)\.|Appendix ([A-Z])\.|([A-Z](?:\.\d+)+)\.)\s+(.+)$|^(Abstract|Status of This Memo|Copyright Notice|Table of Contents|Authors' Addresses|Acknowledgements|Acknowledgments|Contributors)$/;
  // A bordered table is a run of blocks made only of +---+ borders and |...|
  // rows (a page break splits it), ending at its centred "Table N" caption.
  const tblLine = (l) => /^ *(\+[-=]+)+\+ *$|^ *\|.*\| *$/.test(l);
  const isTbl = (b) => b.lines.every(tblLine);
  const items = []; let started = false;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const m = b.lines.length === 1 && b.lines[0].match(headRe);
    if (m) { started = true; items.push({ kind: "h", num: m[1] || (m[2] ? "Appendix " + m[2] : m[3]) || "", title: m[4] || m[5], nums: b.nums }); continue; }
    if (started && isTbl(b) && /^ *\+/.test(b.lines[0])) {
      let j = i; while (j < blocks.length && isTbl(blocks[j])) j++;
      const cap = blocks[j];
      if (cap && cap.lines.length === 1 && /^ +Table \d+$/.test(cap.lines[0])) {
        const run = blocks.slice(i, j);
        items.push({ kind: "tbl", lines: run.flatMap((x) => x.lines), nums: run.flatMap((x) => x.nums), cap });
        i = j; continue;
      }
    }
    items.push({ kind: started ? "raw" : "front", lines: b.lines, nums: b.nums });
  }

  // Reference keys, so only real citations become links.
  const refs = new Set(raw.map((l) => (l.match(/^ {3}\[([A-Za-z][A-Za-z0-9-]*)\]/) || [])[1]).filter(Boolean));
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const idFor = (num, title) => {
    if (!num) return "d-" + ({ "Abstract": "abstract", "Status of This Memo": "status", "Copyright Notice": "copyright", "Table of Contents": "toc-rfc", "Authors' Addresses": "authors" }[title] || title.toLowerCase().replace(/[^a-z]+/g, "-"));
    if (num.startsWith("Appendix ")) return "d-s" + num.slice(9);
    return "d-s" + num.replace(/\./g, "-");
  };
  const secHref = (n) => "#d-s" + n.replace(/\./g, "-");
  const indent = (l) => l.match(/^ */)[0].length;
  const joinText = (ls) => ls.map((l) => l.trim()).reduce((acc, l) => (acc === "" ? l : (/[A-Za-z]-$/.test(acc) || (/-$/.test(acc) && /^>/.test(l))) ? acc + l : acc + " " + l), "").replace(/([.?!:)]) {2}(?=\S)/g, "$1 ");
  const ln = (ns) => ` data-ln="${ns[0]}-${ns[ns.length - 1]}"`;
  // Code literals are found after escaping and parked as placeholders, so
  // later markup never reaches inside them; section, appendix and reference
  // links are matched first and left whole. A literal hyphen may carry the
  // space joinText leaves after a hyphen that ended a line.
  const terms = (opts.codeTerms || []).filter(Boolean);
  const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const codeRe = terms.length && new RegExp(
    "(\\bSections? \\d+(?:\\.\\d+)*|\\bAppendix [A-Z](?:\\.\\d+)*|\\[[A-Za-z][A-Za-z0-9-]*\\]|&lt;https?:\\/\\/[^&]+?&gt;)|" +
    terms.map((x) => {
      const e = esc(x), a = e[0], z = e[e.length - 1];
      const body = e.split(/\s+/).map(reEsc).join(" +").replace(/-(?=.)/g, "- ?");
      // A word-edged literal stands alone; a punctuation-edged one is not
      // part of a longer run of the same mark (".." inside "...").
      const pre = /\w/.test(a) ? "(?<!\\w)" : `(?<!${reEsc(a)})`;
      const post = /\w/.test(z) ? "(?!\\w)(?!\\.\\d)" : `(?!${reEsc(z)})`;
      // A lone letter inside a run of lone characters is an alphabet listing.
      const lone = /^\w$/.test(x) ? "(?<!(?:^|\\s)\\w )(?! \\w(?:\\s|$))" : "";
      return "(?<!&)" + pre + lone + body + post;
    }).join("|"), "g");
  const inline = (t) => {
    let s = esc(t);
    const code = [];
    if (codeRe) s = s.replace(codeRe, (m, keep) => (keep ? m : "\u0001" + (code.push(m) - 1) + "\u0002"));
    s = s.replace(/\*([^*\s](?:[^*]*?[^*\s])?)\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s.,;:)]|$)/g, "$1<em>$2</em>");
    s = s.replace(/\b(MUST NOT|SHALL NOT|SHOULD NOT|NOT RECOMMENDED|MUST|REQUIRED|SHALL|SHOULD|RECOMMENDED|MAY|OPTIONAL)\b/g, '<span class="req">$1</span>');
    s = s.replace(/\bSections? (\d+(?:\.\d+)*)/g, (m, n) => `<a href="${secHref(n)}">${m}</a>`);
    s = s.replace(/\bAppendix ([A-Z])(?:\.(\d+(?:\.\d+)*))?/g, (m, a, b) => `<a href="#d-s${a}${b ? "-" + b.replace(/\./g, "-") : ""}">${m}</a>`);
    s = s.replace(/\[([A-Za-z][A-Za-z0-9-]*)\]/g, (m, k) => (refs.has(k) ? `[<a href="#d-ref-${k}">${k}</a>]` : m));
    s = s.replace(/&lt;(https?:\/\/[^&]+?)&gt;/g, '&lt;<a href="$1" rel="noopener">$1</a>&gt;');
    if (code.length) s = s.replace(/\u0001(\d+)\u0002/g, (m, i) => `<code>${code[i]}</code>`);
    return s;
  };
  const isPre = (b, inAuthors) => {
    if (inAuthors) return false;
    if (Math.min(...b.map(indent)) >= 6) return true;
    const t = b.join("\n");
    if (/^ *[0-9a-f]{8}: /m.test(t)) return true;
    if (/^ *'.'\(\d+\)|word\[|^ *Add z|^ *Index:|^ *Char:|^ *Value +Encoding|^ *Sum after/m.test(t)) return true;
    if (b.every((l) => /^ *(\S )+\S$/.test(l) && l.trim().split(" ").every((x) => x.length === 1))) return true;
    if (/\\n/.test(t) && !/\. {2}\S/.test(t) && !/^ *The (target|delta|source) /.test(b[0])) return true;
    return b.every((l) => /^ *(\S+ += |;|\S)/.test(l)) && /^ *[a-z][\w-]* += /m.test(t) && !/\. {2}\S/.test(t) && !/\.$/.test(b[b.length - 1].trim());
  };

  let html = "", list = null, nested = false, pre = null, dl = false, inAuthors = false, skip = false;
  const front = [], boiler = [];
  let sink = (s) => (html += s);
  const flushPre = () => { if (pre) { sink(`<pre class="rfc-fig"${ln(pre.nums)}>${esc(pre.text.join("\n\n"))}</pre>`); pre = null; } };
  const closeAll = () => {
    flushPre();
    if (nested) { sink("</ul>"); nested = false; }
    if (list) { sink(`</li></${list}>`); list = null; }
    if (dl) { sink("</dl>"); dl = false; }
  };
  // Rows close at each border; a row closed by an =-border is a header row.
  // Cells are cut at the border's + columns, measured from each line's own
  // indent, since a table continued across a page break may shift by a column.
  const table = (L, N) => {
    const rows = []; let cols = [], cells = null;
    for (const l of L) {
      const t = l.trim();
      if (t[0] === "+") {
        if (cells) rows.push({ head: t.includes("="), cells: cells.map((c) => inline(joinText(c.filter((x) => x.trim() !== "")))) });
        cells = null; cols = [...t].flatMap((ch, k) => (ch === "+" ? [k] : []));
        continue;
      }
      const parts = cols.length > 1 && cols.every((k) => t[k] === "|") ? cols.slice(1).map((k, c) => t.slice(cols[c] + 1, k)) : t.slice(1, -1).split("|");
      cells ||= parts.map(() => []);
      parts.forEach((x, c) => (cells[c] ||= []).push(x));
    }
    const tr = (r) => `<tr>${r.cells.map((c) => (r.head ? `<th>${c}</th>` : `<td>${c}</td>`)).join("")}</tr>`;
    const head = rows.filter((r) => r.head), body = rows.filter((r) => !r.head);
    return `<div class="tbl-wrap rfc-tablewrap"><table class="rfc-table"${ln(N)}>${head.length ? `<thead>${head.map(tr).join("")}</thead>` : ""}<tbody>${body.map(tr).join("")}</tbody></table></div>`;
  };
  for (const b of items) {
    if (b.kind === "front") { front.push(b.lines); continue; }
    if (b.kind === "h") {
      closeAll();
      const id = idFor(b.num, b.title);
      inAuthors = id === "d-authors";
      skip = id === "d-toc-rfc";
      sink = id === "d-status" || id === "d-copyright" ? (s) => boiler.push(s) : (s) => (html += s);
      if (skip) continue;
      const depth = !b.num || b.num.startsWith("Appendix") ? 2 : b.num.split(".").length + 1;
      const tag = "h" + Math.min(depth, 4);
      sink(`<${tag} id="${id}" class="rfc-h"${ln(b.nums)}>${b.num ? `<span class="sec">${esc(b.num)}.</span>` : ""}${esc(b.title)}</${tag}>`);
      continue;
    }
    if (skip) continue;
    if (b.kind === "tbl") {
      closeAll();
      sink(table(b.lines, b.nums) + `<p class="rfc-caption"${ln(b.cap.nums)}>${esc(b.cap.lines[0].trim())}</p>`);
      continue;
    }
    const L = b.lines, N = b.nums;
    let m;
    if (!(/^ {7}\*  /.test(L[0]) && list) && isPre(L, inAuthors)) {
      if (list || dl) { const p = pre; pre = null; closeAll(); pre = p; }
      const min = Math.min(...L.map(indent));
      pre ||= { text: [], nums: [] };
      pre.text.push(L.map((l) => l.slice(min)).join("\n")); pre.nums.push(...N);
      continue;
    }
    flushPre();
    if ((m = L[0].match(/^ {7}\*  (.*)$/)) && list) {
      if (!nested) { sink('<ul class="rfc-list">'); nested = true; }
      sink(`<li${ln(N)}>${inline(joinText([m[1], ...L.slice(1)]))}</li>`);
      continue;
    }
    if ((m = L[0].match(/^ {3}(?:(\d+)\.|\*) +(.*)$/)) && !/^ {3}\*[A-Z]/.test(L[0])) {
      const kind = m[1] ? "ol" : "ul";
      if (nested) { sink("</ul>"); nested = false; }
      if (list !== kind) { closeAll(); sink(`<${kind} class="rfc-list"${m[1] && m[1] !== "1" ? ` start="${m[1]}"` : ""}><li${ln(N)}>`); list = kind; }
      else sink(`</li><li${ln(N)}>`);
      sink(inline(joinText([m[2], ...L.slice(1)])));
      continue;
    }
    if ((m = L[0].match(/^ {3}([A-Z][a-z]+): {2}(.*)$/))) {
      if (list) closeAll();
      if (!dl) { sink('<dl class="rfc-dl">'); dl = true; }
      sink(`<dt${ln(N)}>${esc(m[1])}:</dt><dd${ln(N)}>${inline(joinText([m[2], ...L.slice(1)]))}</dd>`);
      continue;
    }
    closeAll();
    if ((m = L[0].match(/^ {3}\[([A-Za-z][A-Za-z0-9-]*)\]/))) { sink(`<p class="rfc-ref" id="d-ref-${m[1]}"${ln(N)}>${inline(joinText(L))}</p>`); continue; }
    if (inAuthors) { sink(`<p class="rfc-addr"${ln(N)}>${L.map((l) => inline(l.trim())).join("<br>")}</p>`); continue; }
    sink(`<p${ln(N)}>${inline(joinText(L))}</p>`);
  }
  closeAll();
  return { head: esc(front.map((b) => b.join("\n")).join("\n\n")), body: html, boiler: boiler.join("") };
}
if (typeof module === "object") module.exports = rfcRender;
