(function () {
  "use strict";
  window.RFC_TOOLS = window.RFC_TOOLS || {};

  // The nineteen defined operators (§5.2.1).
  const OPS = new Set(["login", "push", "pull", "cookie", "clone", "file", "cfile", "uvfile",
    "private", "igot", "uvigot", "gimme", "uvgimme", "reqconfig", "config", "clone_seqno",
    "pragma", "error", "message"]);
  const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  const enc = new TextEncoder(), dec = new TextDecoder();

  // ---- Examples from Appendix A, verbatim apart from elided binary payloads. ----
  const PC = "aa87ea41b0bb05ba528f7a3bdba700d7e23d6318", SC = "da3e69ab0655a7dd2aba2520b2d3302a97c85787";
  const H = {
    m1: "8e0933ed1ef9aa0051d185c8123f0b9ac79865e4b70098b877543fca0092c259",
    f1: "b1c1b05fea4f52bd90b15fdffd13f5c91dce6505f498eeb79b4952c2ea8d4d15",
    p0: "c5b2e0ecb779a7616b32553d973bc9c4ae5a07569a2cee18001386da6bd9ae57",
    m2: "4361252d0f450879dcd2e0b6a42b95ffe8a41d8e948130253ae8eefa7f4b79ea",
    f2: "f5116517775075ea483901021282ba97eebe5a2b993a47eb78198adc10efe128",
  };
  const lines = (a) => a.join("\n") + "\n";
  const EXAMPLES = {
    a1: {
      label: "§A.1, verbatim",
      rounds: [
        {
          request: lines([
            "pragma client-version 22800 20260311 113146",
            `pull ${SC} ${PC}`, `push ${SC} ${PC}`,
            `igot ${H.m1}`, `igot ${H.f1}`, `igot ${H.p0}`,
            "# F2A895EF75B47B7157664A7FEAC978EFFFDB01C4"]),
          response: lines([
            "pragma server-version 22800 20260311 113146",
            `gimme ${H.m1}`, `gimme ${H.f1}`, `igot ${H.m2}`, `igot ${H.f2}`,
            "# timestamp 2026-07-02T18:31:13 errors 0"]),
          note: "The server asks for two of the client's three artifacts and announces two of its own. The client creates two phantoms (§A.1). Both §3.7(a) and §3.7(b) hold. The igot cards created phantoms that are still unfilled, and the gimme cards made the client append content to the next request.",
        },
        {
          request: lines([
            "pragma client-version 22800 20260311 113146",
            `pull ${SC} ${PC}`, `push ${SC} ${PC}`,
            `file ${H.m1} 272`,
            "C client:\\sadd\\salpha.txt", "D 2026-07-02T18:30:46.860", `F alpha.txt ${H.f1}`,
            `P ${H.p0}`, "R 6b3e7488d36fc39ea8093fdea87c3641", "U drh", "Z ed00cdc67449c3949587aa83b3fd8a67",
            `file ${H.f1} 26`, "alpha content from client",
            `gimme ${H.m2}`, `gimme ${H.f2}`,
            `igot ${H.m1}`, `igot ${H.f1}`, `igot ${H.p0}`,
            "# F155AB07186D7F394649AB08DB88BD4179159D07"]),
          response: lines([
            "pragma server-version 22800 20260311 113146",
            `file ${H.m2} 270`,
            "C server:\\sadd\\sbeta.txt", "D 2026-07-02T18:30:46.907", `F beta.txt ${H.f2}`,
            `P ${H.p0}`, "R 5aa7ac70dd267efe64fe354554a33895", "U drh", "Z 7330b90458172595afd5c246c62c096d",
            `file ${H.f2} 31`, "beta content added server-side",
            "# timestamp 2026-07-02T18:31:13 errors 0"]),
          note: "The two file cards fill the client's two phantoms, so the phantom table is empty and §3.7(a) fails. The reply had no gimme, so nothing was appended and §3.7(b) fails too. No round 3 is needed (§A.1), and the server sends no completion card (§3.7).",
        },
      ],
    },
    a2: {
      label: "§A.2, verbatim",
      rounds: [
        {
          request: lines([
            "pragma client-version 19999 20260702 182649", "clone 3 1",
            "# 3A8C1D4EE99F1B0782F7C4A67B39D0C512E7F540"]),
          response: lines([
            "pragma server-version 22800 20260311 113146",
            "error Fossil\\sversion\\s2.0\\sor\\slater\\srequired.",
            "clone_seqno 0",
            "push 34302acad64fe2397bd907704dec457899e2f9a3 c85e3efddf993e86e8325d08672ea94bdba6c2c4",
            "# timestamp 2026-07-02T18:26:49 errors 0"]),
          http: { rep: ["HTTP 200, Content-Type: application/x-fossil-uncompressed, Content-Length: 235"] },
          note: "Release 19999 is below 20000, so the server refuses the SHA3 artifact with an error in its RID position, and no SHA1 fallback happens (§7.6, §A.2). In the first clone reply that error is not terminal. The client keeps parsing, records the project code from the later push, and must send a second request (§8.3). §A.2 calls it the second clone request. With clone_seqno 0 recorded, §8.2 bars a further clone card, so §3.7 sends it as the operation-less cleanup. The appendix stops here.",
        },
      ],
    },
    a3: {
      label: "§A.3 scenario 4, binary delta elided",
      rounds: [
        {
          request: lines([
            "login privuser ee71329ef84fb77b428c6f626ad0103a426e0652 c3ee0be781c9ebcfc6e24756cbb75e6319ca255b",
            "pragma send-private",
            "pragma client-version 22800 20260311 113146",
            "pull 3921d47b51aad4027faac6467b4a87b4e7951c64 ea2e766b68008b6c3b3ca547df136ded07c7f921",
            "# 7258235C6A6B727E5C0F6E2E2576D36A234E63A3"]),
          http: { req: ["POST / HTTP/1.0", "Content-Type: application/x-fossil-debug", "Content-Length: 291"] },
          response: lines([
            "pragma server-version 22800 20260311 113146",
            "igot 23813573dea5ec687052a067866751f481e58ef4c478939ac601587a43f50b35",
            "igot 2c215398c6ea4e3c0994d41918f632d5208d6a24da3ac894c9d9d167a711f30b",
            "igot ed76b084599a372a5a17232f0bb67211145c0bde6b5a5ff542813d60fa07d3dc",
            "igot 393953a9803595823fb560ddbe333767840a5ad89748a12fc2cd00f533c6df8a 1",
            "igot da4b6b0ea2b060ff6bf29c16a3b10be05afc9c1a75d605a45cf7267ea3e74091 1",
            "# timestamp 2026-07-02T18:34:48 errors 0"]),
          note: "The first private round puts send-private before client-version (§3.1). The user holds x, so the server announces its two private artifacts with igot HASH 1 next to the public ones (§7.5, §9.5).",
        },
        {
          request: lines([
            "pragma client-version 22800 20260311 113146",
            "pragma send-private",
            "pull 3921d47b51aad4027faac6467b4a87b4e7951c64 ea2e766b68008b6c3b3ca547df136ded07c7f921",
            "gimme 393953a9803595823fb560ddbe333767840a5ad89748a12fc2cd00f533c6df8a",
            "gimme da4b6b0ea2b060ff6bf29c16a3b10be05afc9c1a75d605a45cf7267ea3e74091",
            "# 4D85B916A821F5198416D9F01D4F75F45714F45C"]),
          http: { req: ["POST / HTTP/1.0",
            "Cookie: x-f-l-c=login+privuser+653828a8fc753c1685501de457c104f0b20938c9+bec32fbc6a2589413ee6d1f47a4ae0098dafcad2",
            "Content-Type: application/x-fossil-debug", "Content-Length: 336"] },
          response: lines([
            "pragma server-version 22800 20260311 113146",
            "private",
            "file 393953a9803595823fb560ddbe333767840a5ad89748a12fc2cd00f533c6df8a 49",
            "Private content -- must not reach x-less peers.",
            "private",
            "file da4b6b0ea2b060ff6bf29c16a3b10be05afc9c1a75d605a45cf7267ea3e74091 ed76b084599a372a5a17232f0bb67211145c0bde6b5a5ff542813d60fa07d3dc 317",
            "… 317 binary delta bytes elided …",
            "igot 23813573dea5ec687052a067866751f481e58ef4c478939ac601587a43f50b35",
            "igot 2c215398c6ea4e3c0994d41918f632d5208d6a24da3ac894c9d9d167a711f30b",
            "igot ed76b084599a372a5a17232f0bb67211145c0bde6b5a5ff542813d60fa07d3dc",
            "igot 393953a9803595823fb560ddbe333767840a5ad89748a12fc2cd00f533c6df8a 1",
            "igot da4b6b0ea2b060ff6bf29c16a3b10be05afc9c1a75d605a45cf7267ea3e74091 1",
            "# timestamp 2026-07-02T18:34:48 errors 0"]),
          note: "The server now reports 22800 dated 2026-03-11, which passes the §6.5 gate, so round 2 logs in through the Cookie header and the body has no login card. Each private card marks the next file (§7.5). The second file is a delta against ed76…, which the server announced publicly. The printed first payload is 48 bytes against a declared 49, so this replay finds its end at the next card line. The appendix stops after this reply.",
        },
      ],
    },
  };

  // ---- Card text parsing, tolerant of elided payloads. ----
  function isElision(line) {
    const t = line.trim().split(/\s+/)[0] || "";
    return !OPS.has(t) && /\belided\b/i.test(line);
  }
  function payloadSize(tok) {
    const n = (s) => (/^\d+$/.test(s || "") ? parseInt(s, 10) : -1);
    switch (tok[0]) {
      case "file": return tok.length >= 4 && HASH.test(tok[2]) ? n(tok[3]) : n(tok[2]);
      case "cfile": return tok.length >= 5 && HASH.test(tok[2]) ? n(tok[4]) : n(tok[3]);
      case "uvfile": { const sz = n(tok[4]), fl = n(tok[5]); return sz > 0 && fl >= 0 && !(fl & 5) ? sz : 0; }
      case "config": return n(tok[2]);
      default: return 0;
    }
  }
  function parseCards(text) {
    const b = enc.encode(text || ""), out = [];
    let i = 0;
    const lineAt = (p) => { let j = b.indexOf(10, p); if (j < 0) j = b.length; return [dec.decode(b.subarray(p, j)), j + 1]; };
    while (i < b.length) {
      const [line, next] = lineAt(i);
      i = next;
      if (line.trim() === "") continue;
      if (isElision(line)) { out.push({ kind: /rest of message/i.test(line) ? "truncated" : "elided", line: line.trim() }); continue; }
      if (line.startsWith("#")) { out.push({ kind: "comment", line }); continue; }
      const tok = line.trim().split(/[ \t\v\f\r]+/);
      const card = { kind: "card", line, tok, op: tok[0] };
      out.push(card);
      const n = payloadSize(tok);
      if (n <= 0 || i >= b.length) continue;
      const [peek, after] = lineAt(i);
      if (isElision(peek) && !/rest of message/i.test(peek)) { card.payload = { size: n, elided: peek.trim() }; i = after; continue; }
      const end = i + n;
      if (end <= b.length && (end === b.length || b[end - 1] === 10 || b[end] === 10)) {
        card.payload = { size: n, text: dec.decode(b.subarray(i, end)) };
        i = end;
        if (b[end - 1] !== 10 && b[i] === 10 && (card.op === "cfile" || card.op === "config")) i++;
        continue;
      }
      // The count does not land on a line boundary: take lines up to the next card.
      let body = "";
      while (i < b.length) {
        const [l, a] = lineAt(i);
        const t = l.trim().split(/\s+/)[0] || "";
        if (OPS.has(t) || l.startsWith("#") || isElision(l)) break;
        body += l + "\n"; i = a;
      }
      if (body) card.payload = { size: n, text: body, approx: true };
    }
    return out;
  }

  // ---- What each card means, by direction. ----
  const defoss = (s) => (s || "").replace(/\\(.)/g, (m, c) =>
    ({ s: " ", t: "\t", n: "\n", r: "\r", f: "\f", v: "\v", 0: "\0", "\\": "\\" })[c] ?? m);
  const release = (v) => { const x = parseInt(v, 10); if (!(x >= 0)) return v; return `${Math.floor(x / 10000)}.${String(Math.floor(x / 100) % 100).padStart(2, "0")}.${String(x % 100).padStart(2, "0")}`; };
  const short = (h) => h.slice(0, 10) + "…";
  const hashKind = (h) => (h.length === 64 ? "SHA3-256" : "SHA1");

  function explainPragma(t, dir) {
    const name = t[1] || "";
    switch (name) {
      case "client-version": return ["§9.1", `Client release ${t[2]} (Fossil ${release(t[2])})${t[3] ? `, built ${t[3]} ${t[4] || ""}` : ""}. Every request carries it, before any card that asks for content (§3.1).`];
      case "server-version": return ["§9.1", `Server release ${t[2]} (Fossil ${release(t[2])}). It sets the client's SHA3 (§7.6), private-igot (§8.6) and cookie-login (§6.5) gates.`];
      case "send-private": return ["§9.5", "Asks for private content. It works only for a caller with capability x."];
      case "send-catalog": return ["§9.5", "Asks the server to announce every eligible artifact it holds."];
      case "req-clusters": return ["§9.5", "Asks for public cluster igot cards."];
      case "req-links": return ["§9.5", "Allows pragma link cards in the reply to this request."];
      case "client-url": return ["§9.5", "Tells the server where this client syncs from."];
      case "uv-hash": return ["§9.2", "SHA-1 of the client's unversioned catalog. A mismatch makes the server send its full catalog."];
      case "uv-push-ok": return ["§9.2", "The client may upload unversioned files. The full catalog follows."];
      case "uv-pull-only": return ["§9.2", "The client may not upload unversioned files. The full catalog follows."];
      case "ci-lock": return ["§9.4", "Asks for a check-in lock on this hash. Success is silent."];
      case "ci-unlock": return ["§9.4", "Releases this client's check-in locks. No reply."];
      case "ci-lock-fail": return ["§9.4", "Another client holds the check-in lock."];
      case "avoid-delta-manifests": return ["§9.5", "Send manifests in full for the rest of the session."];
      case "link": return ["§9.5", "An alternative location for this repository."];
      default: return ["§9", "Unknown pragma names are ignored."];
    }
  }
  function explain(item, dir) {
    if (item.kind === "comment") {
      const l = item.line;
      if (/^# timestamp /.test(l)) return ["§5.3", "Server time in UTC, used to estimate clock skew. The error count is informational."];
      if (/^# (sending|end-of)-clusters/.test(l)) return ["§5.3", "Brackets a run of cluster igot cards. Receivers ignore it."];
      return dir === "req" ? ["§5.3", "Random bytes. Every request ends with them, which changes the body the login nonce covers."] : ["§5.3", "A comment line. It is never dispatched as a card."];
    }
    if (item.kind === "elided") return ["§5.1", "Payload left out of this replay."];
    if (item.kind === "truncated") return ["", "The rest of this message is too long to show here."];
    const t = item.tok, op = item.op;
    const pv = (i) => (t[i] && HASH.test(t[i]) ? t[i] : null);
    switch (op) {
      case "login": return ["§6.1", `Named login for ${defoss(t[1])}. The nonce is the SHA-1 of every body byte after this line (§6.2), and the signature proves the password (§6.4).`];
      case "pragma": return explainPragma(t, dir);
      case "pull": case "push":
        return dir === "req"
          ? ["§8.5", `${op === "pull" ? "Pull" : "Push"} with servercode and projectcode. ${op === "pull" ? "The server's igot cards become phantoms here." : "The client's igot cards become phantoms on the server."}`]
          : ["§3.1.1", `The server's servercode and projectcode. ${op === "push" ? "A clone reissue needs a well-formed push in the reply (§8.2)." : ""}`];
      case "clone": return ["§8.1", `Clone version ${t[1]}, starting at blob RID ${t[2]} (§8.2).${t[2] === "1" ? " The first clone request carries no login (§8.3)." : ""}`];
      case "clone_seqno": return ["§8.2", t[1] === "0" ? "0: the server has nothing more to send. Clone cards are barred for the rest of the session." : `Next RID to ask for. The client records it and may reissue clone 3 ${t[1]}.`];
      case "igot": {
        const priv = t[2] === "1";
        return dir === "req"
          ? ["§8.6", `The client holds ${priv ? "this private" : "this"} ${hashKind(t[1])} artifact. If the server lacks it and accepts the push, it becomes a server phantom (§3.3).`]
          : ["§3.3", `The server holds ${priv ? "this private" : "this"} artifact. If the client lacks it and is pulling, it becomes a phantom${priv ? ", private if private sync is on (§7.5)" : ""}.`];
      }
      case "gimme": return dir === "req"
        ? ["§3.3", "Asks for the content of a phantom."]
        : ["§3.3", "The server lacks this. With push on, the client appends the content to its next request (§3.1.1)."];
      case "file": {
        const delta = pv(2);
        return ["§7.1", delta ? `Delta against ${short(delta)}, ${t[3]} bytes. A missing source becomes a phantom (§7.4).` : `Full content, ${t[2]} bytes. Storing it deletes the phantom (§3.3).`];
      }
      case "cfile": {
        const delta = pv(2);
        return ["§7.2", delta
          ? `Stored compressed delta against ${short(delta)}: ${t[4]} bytes on the wire for a ${t[3]}-byte artifact.`
          : `Stored compressed artifact: ${t[3]} bytes on the wire for a ${t[2]}-byte artifact.`];
      }
      case "private": return ["§7.5", "Marks the next file or cfile as private."];
      case "cookie": return dir === "req" ? ["§3.6", "Returns the server's opaque cookie."] : ["§3.6", "The client replaces its stored cookie with this one."];
      case "error": {
        const txt = defoss(t.slice(1).join(" "));
        if (/version 2\.0 or later required/.test(txt)) return ["§7.6", `“${txt}” The SHA3 gate refused one artifact.`];
        return ["§10.1", `“${txt}”${dir === "rep" ? " Ends this reply's card loop, then §3.7 decides." : ""}`];
      }
      case "message": return ["§10.2", `“${defoss(t[1])}” Advisory text.`];
      case "uvigot": return ["§8.5.1", "One catalog entry. The client computes a status from 0 to 5 for it."];
      case "uvgimme": return ["§7.3", "Asks for one unversioned file."];
      case "uvfile": return ["§7.3", "Unversioned file content or metadata."];
      case "reqconfig": return ["§9.3", "Asks for a configuration group."];
      case "config": return ["§9.3", `Configuration group ${t[1]}, ${t[2]} bytes and an LF.`];
      default: return ["§5.2", dir === "req" ? "Unknown operator: the server answers error bad command." : "Unknown operator: the client warns and stops reading this reply."];
    }
  }

  // ---- SHA-1, for the login tool. ----
  function sha1(bytes) {
    const ml = bytes.length, nb = ((ml + 8) >> 6) + 1, w = new Uint32Array(nb * 16);
    for (let i = 0; i < ml; i++) w[i >> 2] |= bytes[i] << (24 - (i & 3) * 8);
    w[ml >> 2] |= 0x80 << (24 - (ml & 3) * 8);
    w[nb * 16 - 1] = ml * 8;
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const x = new Uint32Array(80);
    for (let blk = 0; blk < nb * 16; blk += 16) {
      for (let t = 0; t < 16; t++) x[t] = w[blk + t];
      for (let t = 16; t < 80; t++) { const v = x[t - 3] ^ x[t - 8] ^ x[t - 14] ^ x[t - 16]; x[t] = (v << 1) | (v >>> 31); }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let t = 0; t < 80; t++) {
        const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
        const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
        const tmp = (((a << 5) | (a >>> 27)) + f + e + k + x[t]) >>> 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    return [h0, h1, h2, h3, h4].map((v) => v.toString(16).padStart(8, "0")).join("");
  }
  const sha1s = (s) => sha1(enc.encode(s));

  RFC_TOOLS.sp = {
    init(root, ctx) {
      const $ = (s) => ctx.$(s, root);
      const el = ctx.el;

      // ---- Replay ----
      const st = { src: null, rounds: [], i: 0 };
      const tbodyReq = $("#sp-rp-req"), tbodyRep = $("#sp-rp-rep");

      function codeCell(text) {
        const td = el("td"), lines = text.replace(/\n$/, "").split("\n");
        const shown = lines.slice(0, 9);
        shown.forEach((l, k) => {
          if (k) td.appendChild(el("br"));
          td.appendChild(el("code", null, l.replace(/[0-9a-fA-F]{32,}/g, short).replace(/[\x00-\x08\x0e-\x1f\x7f\ufffd]/g, "·")));
        });
        if (lines.length > shown.length) { td.appendChild(el("br")); td.appendChild(el("code", null, `… ${lines.length - shown.length} more lines`)); }
        td.title = text;
        return td;
      }
      function row(tbody, code, sec, text) {
        const tr = el("tr");
        tr.appendChild(typeof code === "string" ? codeCell(code) : code);
        tr.appendChild(el("td", "num", sec));
        tr.appendChild(el("td", null, text));
        tbody.appendChild(tr);
      }
      function fill(tbody, text, dir, http) {
        tbody.textContent = "";
        (http || []).forEach((h) => {
          const cookie = /^Cookie: x-f-l-c=/.test(h);
          row(tbody, h, cookie ? "§6.5" : "§4", cookie ? "HTTP header. Cookie login replaces the body login card." : "HTTP framing, outside the card body.");
        });
        const items = parseCards(text);
        let cards = 0;
        for (const it of items) {
          const [sec, msg] = explain(it, dir);
          row(tbody, it.line, sec, msg);
          if (it.kind === "card") cards++;
          if (it.payload) {
            const p = it.payload;
            if (p.elided) row(tbody, p.elided, "§5.1", `Payload of ${p.size} bytes, counted by the card above. Left out of this replay.`);
            else row(tbody, p.text, "§5.1", `Payload, ${p.size} bytes counted by the card above. These lines are data, not cards.${p.approx ? " The printed bytes do not match the count, so the replay ends the payload at the next card." : ""}`);
          }
        }
        return cards;
      }
      function draw() {
        const r = st.rounds[st.i];
        if (!r) return;
        const nReq = fill(tbodyReq, r.request, "req", r.http && r.http.req);
        const nRep = fill(tbodyRep, r.response, "rep", r.http && r.http.rep);
        $("#sp-rp-req-h").textContent = `Round ${st.i + 1} request`;
        $("#sp-rp-rep-h").textContent = `Round ${st.i + 1} reply`;
        const stats = $("#sp-rp-stats");
        stats.textContent = "";
        const stat = (b, t) => { const s = el("span"); s.appendChild(el("b", null, b)); s.appendChild(document.createTextNode(" " + t)); stats.appendChild(s); };
        stat(`${st.i + 1} of ${st.rounds.length}`, "rounds");
        stat(String(nReq), "request cards");
        stat(String(nRep), "reply cards");
        if (r.reqBytes != null) stat(Number(r.reqBytes).toLocaleString("en"), "B request");
        if (r.resBytes != null) stat(Number(r.resBytes).toLocaleString("en"), "B reply");
        if (st.live && st.live.blobs != null) stat(String(st.live.blobs), "blobs cloned");
        if (st.live && st.live.bytes != null) stat(Number(st.live.bytes).toLocaleString("en"), "bytes");
        $("#sp-rp-note").textContent = r.note || "";
        $("#sp-rp-prev").disabled = st.i === 0;
        $("#sp-rp-next").disabled = st.i >= st.rounds.length - 1;
        root.querySelectorAll("#sp-rp-pick [data-ex]").forEach((bt) => bt.setAttribute("aria-pressed", String(bt.dataset.ex === st.src)));
      }
      function setSource(label, live) {
        const box = $("#sp-rp-source");
        box.textContent = "";
        box.appendChild(el("span", live === "bad" ? "status bad" : live ? "status ok" : "status", live ? label : `Example · ${label}`));
      }
      function load(key) {
        const ex = EXAMPLES[key];
        st.src = key; st.rounds = ex.rounds; st.i = 0; st.live = null;
        setSource(ex.label, false);
        draw();
      }
      root.querySelectorAll("#sp-rp-pick [data-ex]").forEach((bt) => bt.addEventListener("click", () => load(bt.dataset.ex)));
      $("#sp-rp-prev").addEventListener("click", () => { if (st.i > 0) { st.i--; draw(); } });
      $("#sp-rp-next").addEventListener("click", () => { if (st.i < st.rounds.length - 1) { st.i++; draw(); } });
      load("a1");

      RFC_TOOLS.sp._live = function (result) {
        const rounds = (result.rounds || []).map((r) => ({ request: r.request || "", response: r.response || "", reqBytes: r.reqBytes, resBytes: r.resBytes }));
        const cards = (t) => parseCards(t).filter((x) => x.kind === "card");
        const OPS_DIR = new Set(["clone", "push", "pull"]);
        rounds.forEach((r, k) => {
          const req = parseCards(r.request), rep = cards(r.response);
          const count = (op) => rep.filter((x) => x.op === op).length;
          const seq = rep.find((x) => x.op === "clone_seqno");
          const parts = [];
          const kinds = ["cfile", "file", "igot", "gimme"].filter((op) => count(op)).map((op) => `${count(op)} ${op}`);
          const total = ["cfile", "file", "igot", "gimme"].reduce((n, op) => n + count(op), 0);
          parts.push(`This reply carried ${kinds.length ? kinds.join(", ") : "no content or igot"} card${total === 1 ? "" : "s"}${seq ? `, and clone_seqno ${seq.tok[1]}` : ""}.`);
          const isClone = req.some((x) => x.kind === "card" && x.op === "clone");
          if (isClone && count("file")) parts.push("§7.1 says clone 3 server transfer uses cfile, not file; this reply also carries file cards.");
          if (!req.length || req[req.length - 1].kind !== "comment") parts.push("The request does not end with the random comment that §3.1 and §5.3 require.");
          if (k === 0 && count("error")) parts.push("Errors in the first clone reply are ignored as errors, and a second request is mandatory (§8.3).");
          const next = rounds[k + 1];
          if (next) {
            const ops = cards(next.request).filter((x) => OPS_DIR.has(x.op));
            const nc = ops.find((x) => x.op === "clone");
            if (nc) parts.push(`The next request reissues clone 3 ${nc.tok[2]} (§8.2).`);
            else if (!ops.length) parts.push("The next request has no operation card, the cleanup request of §8.2.");
            else parts.push(`The next request carries ${ops.map((x) => x.op).join(" and ")} (§8.5). §8.2 describes a clone continuing with clone 3 NEXT or an operation-less cleanup, so this step goes beyond the draft's clone loop.`);
          } else if (!result.error) {
            parts.push(`${seq && seq.tok[1] === "0" ? "clone_seqno 0 means the blob table is exhausted (§8.2). " : ""}This is the last round the clone recorded. Under §3.7 a client stops when no continuation condition holds, and the server sends no completion card.`);
          }
          r.note = parts.join(" ");
        });
        if (result.error) {
          const msg = `The clone stopped with an error: ${result.error}`;
          if (rounds.length) rounds[rounds.length - 1].note += " " + msg;
          else rounds.push({ request: "", response: "", note: msg });
        }
        st.src = "live"; st.rounds = rounds; st.i = 0;
        st.live = { blobs: result.blobs, bytes: result.bytes };
        setSource(result.error ? "Live clone, stopped with an error" : "Live clone of this repository", result.error ? "bad" : true);
        draw();
      };

      // ---- Login ----
      const A5 = { n: "5dfa03bd8645938b4e312a4fcdad5ebe6d4d4840", k: "d7a235115bf97d126c42140196c4fc6087312353", s: "e3dba1c99442823b76ae64a8afca940e0327f9f8" };
      function auth() {
        const u = $("#sp-auth-user").value, pw = $("#sp-auth-pw").value, pc = $("#sp-auth-pc").value.trim(), body = $("#sp-auth-body").value;
        const nonce = sha1s(body), secret = sha1s(`${pc}/${u}/${pw}`), sig = sha1s(nonce + secret);
        const fu = u.replace(/\\/g, "\\\\").replace(/ /g, "\\s");
        $("#sp-auth-out").textContent =
          `NONCE         = SHA1(body)                 = ${nonce}\n` +
          `shared-secret = SHA1(project/user/password) = ${secret}\n` +
          `SIGNATURE     = SHA1(NONCE || secret)      = ${sig}\n\n` +
          `login ${fu} ${nonce} ${sig}\n` +
          `Cookie: x-f-l-c=login+${encodeURIComponent(fu)}+${nonce}+${sig}`;
        const chk = $("#sp-auth-check");
        chk.textContent = "";
        const same = nonce === A5.n && secret === A5.k && sig === A5.s;
        chk.appendChild(el("span", same ? "status ok" : "status", same ? "Matches §A.5" : "Your own values"));
      }
      ["#sp-auth-user", "#sp-auth-pw", "#sp-auth-pc", "#sp-auth-body"].forEach((s) => $(s).addEventListener("input", auth));
      auth();

      // ---- Unversioned status ----
      const ACTION = {
        0: (dash) => dash ? "Remote wins. The remote entry is a deletion and there is no local row, so nothing changes." : "Remote wins. Append one uvgimme for this name while reading this uvigot.",
        1: (dash) => dash ? "Remote wins. Store the remote mtime and clear the local hash, size, encoding and content." : "Remote wins. Append one uvgimme and delete the existing local row at once.",
        2: () => "Same hash, remote newer. Update the local mtime only.",
        3: () => "Identical. Nothing to do.",
        4: () => "Same hash, local mtime newer. If upload is allowed, keep the row in the send table as mtime-only.",
        5: () => "Local content or deletion wins. If upload is allowed, keep or add the row in the send table with full content.",
      };
      function uv() {
        const lh = $("#sp-uv-lh").value.trim(), rh = $("#sp-uv-rh").value.trim() || "-";
        const lm = Number($("#sp-uv-lm").value), rm = Number($("#sp-uv-rm").value);
        const out = $("#sp-uv-out"), pill = $("#sp-uv-status"), stats = $("#sp-uv-stats");
        pill.textContent = ""; stats.textContent = "";
        if (lh && !(Number.isFinite(lm) && Number.isFinite(rm))) {
          pill.appendChild(el("span", "status bad", "Mtimes must be numbers"));
          out.textContent = "";
          return;
        }
        let status, steps;
        if (!lh) { status = 0; steps = "1. No local row: status 0."; }
        else {
          const mc = Math.sign(lm - rm), hc = lh < rh ? -1 : lh > rh ? 1 : 0;
          steps = `2. MTIME-CMP = ${mc} (local ${mc < 0 ? "older" : mc > 0 ? "newer" : "same time"}), HASH-CMP = ${hc}.\n`;
          if (hc === 0) { status = 3 + mc; steps += `3. Equal hashes: status 3 + MTIME-CMP = ${status}.`; }
          else if (mc < 0 || (mc === 0 && hc < 0)) { status = 1; steps += "4. Hashes differ and the local side is older, or the same age with the lower hash: status 1."; }
          else { status = 5; steps += "5. Otherwise: status 5."; }
        }
        pill.appendChild(el("span", status <= 2 ? "status ok" : "status", `Status ${status}`));
        const s = el("span"); s.appendChild(el("b", null, status <= 2 ? "remote" : status === 3 ? "neither" : "local")); s.appendChild(document.createTextNode(" side wins"));
        stats.appendChild(s);
        if (status >= 4) { const r = el("span"); r.appendChild(el("b", null, String(status === 4 ? 2 : 1))); r.appendChild(document.createTextNode(" under revert")); stats.appendChild(r); }
        out.textContent = `${steps}\n\n${ACTION[status](rh === "-")}${status <= 3 ? "\nAfterwards the name leaves the send table." : "\nA pull-only session removes it from the send table instead."}`;
      }
      ["#sp-uv-lh", "#sp-uv-lm", "#sp-uv-rh", "#sp-uv-rm"].forEach((s) => $(s).addEventListener("input", uv));
      uv();
    },

    onRepo(api, ctx) {
      const root = document.getElementById("sp-replay-tool");
      if (!root || typeof api.cloneDemo !== "function") return;
      const btn = root.querySelector("#sp-rp-live");
      btn.disabled = false;
      btn.onclick = () => {
        btn.disabled = true;
        btn.textContent = "Cloning…";
        setTimeout(() => {
          try {
            const res = JSON.parse(api.cloneDemo());
            if (res && res.error && !res.rounds) throw new Error(res.error);
            RFC_TOOLS.sp._live(res);
            btn.textContent = "Run the clone again";
          } catch (e) {
            root.querySelector("#sp-rp-note").textContent = `The clone could not run: ${e.message}`;
            btn.textContent = "Run a real clone";
          }
          btn.disabled = false;
        }, 30);
      };
    },
  };
})();
