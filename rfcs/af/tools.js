// Tools for the Artifact Format reading: the hero manifest, artifact naming,
// a token tester, and an artifact inspector that switches to this draft's own
// check-in manifests once the repository is open.
(function () {
  "use strict";

  // ---- Hashes. MD5 (RFC 1321) for Z and R cards, SHA-1 and SHA3-256 for names.

  const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

  function hex(words, littleEndian) {
    let out = "";
    for (const w of words) {
      for (let i = 0; i < 4; i++) {
        const b = littleEndian ? (w >>> (8 * i)) & 255 : (w >>> (24 - 8 * i)) & 255;
        out += b.toString(16).padStart(2, "0");
      }
    }
    return out;
  }

  function pad64(bytes, bigEndianLength) {
    const n = bytes.length, total = (((n + 8) >>> 6) + 1) * 64;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[n] = 0x80;
    const lo = (n * 8) >>> 0, hi = Math.floor(n / 0x20000000);
    const dv = new DataView(buf.buffer);
    if (bigEndianLength) { dv.setUint32(total - 8, hi); dv.setUint32(total - 4, lo); }
    else { dv.setUint32(total - 8, lo, true); dv.setUint32(total - 4, hi, true); }
    return dv;
  }

  function md5(bytes) {
    const dv = pad64(bytes, false);
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    const M = new Int32Array(16);
    for (let off = 0; off < dv.byteLength; off += 64) {
      for (let j = 0; j < 16; j++) M[j] = dv.getInt32(off + 4 * j, true);
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
        else { f = c ^ (b | ~d); g = (7 * i) & 15; }
        const s = MD5_S[(i >> 4) * 4 + (i & 3)];
        const t = (a + f + MD5_K[i] + M[g]) | 0;
        a = d; d = c; c = b;
        b = (b + ((t << s) | (t >>> (32 - s)))) | 0;
      }
      a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
    }
    return hex([a0, b0, c0, d0], true);
  }

  function sha1(bytes) {
    const dv = pad64(bytes, true);
    const h = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0];
    const w = new Int32Array(80);
    for (let off = 0; off < dv.byteLength; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + 4 * i);
      for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
      let [a, b, c, d, e] = h;
      for (let i = 0; i < 80; i++) {
        const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
        const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc | 0 : 0xca62c1d6 | 0;
        const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;
    }
    return hex(h, false);
  }

  const KECCAK_RC = ["1", "8082", "800000000000808a", "8000000080008000", "808b", "80000001", "8000000080008081",
    "8000000000008009", "8a", "88", "80008009", "8000000a", "8000808b", "800000000000008b", "8000000000008089",
    "8000000000008003", "8000000000008002", "8000000000000080", "800a", "800000008000000a", "8000000080008081",
    "8000000000008080", "80000001", "8000000080008008"].map((x) => BigInt("0x" + x));
  const KECCAK_ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
  const M64 = (1n << 64n) - 1n;
  const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64);

  function keccakF(s) {
    const C = new Array(5), B = new Array(25);
    for (let round = 0; round < 24; round++) {
      for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) s[x + y] ^= D;
      }
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], KECCAK_ROT[x + 5 * y]);
      for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) s[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & M64 & B[((x + 2) % 5) + y]);
      s[0] ^= KECCAK_RC[round];
    }
  }

  function sha3(bytes) {
    const rate = 136, n = bytes.length, q = rate - (n % rate);
    const buf = new Uint8Array(n + q);
    buf.set(bytes);
    buf[n] ^= 0x06;
    buf[n + q - 1] ^= 0x80;
    const s = new Array(25).fill(0n);
    for (let off = 0; off < buf.length; off += rate) {
      for (let i = 0; i < rate / 8; i++) {
        let lane = 0n;
        for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(buf[off + 8 * i + j]);
        s[i] ^= lane;
      }
      keccakF(s);
    }
    let out = "";
    for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out += Number((s[i] >> BigInt(8 * j)) & 255n).toString(16).padStart(2, "0");
    return out;
  }

  // ---- Byte helpers. Card text is handled as one char per octet, so string
  // comparison is the unsigned-octet comparison of §4.5.3.

  const te = new TextEncoder(), td = new TextDecoder();
  const oct = (bytes, a = 0, b = bytes.length) => { let s = ""; for (let i = a; i < b; i++) s += String.fromCharCode(bytes[i]); return s; };
  const toBytes = (o) => Uint8Array.from(o, (c) => c.charCodeAt(0));
  const show = (o) => td.decode(toBytes(o));
  const short = (h) => (h && h.length > 12 ? h.slice(0, 10) + "…" : h);
  const isHex = (s, ...lens) => lens.includes(s.length) && /^[0-9a-fA-F]+$/.test(s);
  const isHash = (s) => isHex(s, 40, 64);
  const algo = (h) => (h.length === 64 ? "SHA3-256" : "SHA-1");

  // §4.3: eight escape pairs; any other "\C" is C; a final backslash stays.
  function unescape(t) {
    const map = { n: "\n", s: " ", t: "\t", r: "\r", v: "\v", f: "\f", 0: "\0", "\\": "\\" };
    let out = "";
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "\\" && i + 1 < t.length) { const c = t[++i]; out += c in map ? map[c] : c; }
      else out += t[i];
    }
    return out;
  }

  // §4.6.1
  function pathnameFault(s) {
    if (s === "") return "it is empty";
    if (s[0] === "/") return "it starts with /";
    if (s === "." || s === "..") return "it is . or ..";
    if (s.startsWith("./") || s.startsWith("../")) return "it starts with ./ or ../";
    if (s.includes("//")) return "it contains //";
    if (s.endsWith("/")) return "it ends with /";
    if (s.includes("/./") || s.includes("/../") || s.endsWith("/.") || s.endsWith("/..")) return "a path element is . or ..";
    return null;
  }

  // §4.6.1, writer profile.
  function writerFault(s) {
    if (s.includes("\\")) return "it contains a backslash";
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(toBytes(s)); } catch (e) { return "it is not valid UTF-8"; }
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp > 0xffff) return "it has a character above U+FFFF";
      if (cp >= 0xe000 && cp <= 0xf8ff) return "it has a private-use character";
      if ((cp >= 0xfdd0 && cp <= 0xfdef) || cp >= 0xfffe) return "it has a noncharacter";
    }
    return null;
  }

  // §4.6.2
  function wikiFault(s) {
    if (s.length < 1 || s.length > 100) return "its length is outside 1 to 100 bytes";
    if (s.charCodeAt(0) <= 0x20) return "its first byte is a space or control byte";
    for (let i = 1; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return "it contains a control byte";
    if (s.includes("  ")) return "it has two spaces in a row";
    if (s.endsWith(" ")) return "it ends with a space";
    return null;
  }

  // §4.6.3
  function isReserved(s) {
    let rest = s, stripped = false;
    const low = s.toLowerCase();
    for (const sfx of ["-wal", "-shm", "-journal"]) {
      if (low.endsWith(sfx)) { rest = s.slice(0, s.length - sfx.length); stripped = true; break; }
    }
    const lr = rest.toLowerCase();
    for (const tail of ["_fossil_", ".fslckout"]) {
      if (!lr.endsWith(tail)) continue;
      const before = rest.length - tail.length;
      if (before === 0 || rest[before - 1] === "/" || stripped) return true;
    }
    return false;
  }

  // §4.6.4: the parser's accepted forms, and whether the token is the writer form.
  function timestampFault(t) {
    if (/^(now|subsec|subsecond)$/i.test(t)) return { form: "a relative literal, resolved at parse time" };
    if (/^\d+(\.\d+)?$/.test(t) && !/^\d{2}:/.test(t)) {
      const r = parseFloat(t);
      return r > 0 && r < 5373484.5 ? { form: "a Julian day number" } : { fault: "a Julian day number must be above 0 and below 5373484.5" };
    }
    const m = /^(-?)(\d{4})-(\d{2})-(\d{2})(?:[\sT]+(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:\s*(?:[+-]\d{2}:\d{2}|[Zz]))?)?$/.exec(t);
    const tm = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/.exec(t);
    if (!m && !tm) return { fault: "it is not a date, time, Julian day or literal the parser accepts" };
    const [hh, mi, ss] = m ? [m[5], m[6], m[7]] : [tm[1], tm[2], tm[3]];
    if (hh !== undefined && (+hh > 24 || +mi > 59 || (ss !== undefined && +ss > 59))) return { fault: "an hour, minute or second is out of range" };
    if (tm) return { form: "a time only, read as a time on 2000-01-01" };
    const y = (m[1] ? -1 : 1) * +m[2], mo = +m[3], d = +m[4];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return { fault: "the month or day is out of range" };
    if (y < -4713 || (y === -4713 && (mo < 11 || (mo === 11 && d <= 24)))) return { fault: "the date is not after -4713-11-24" };
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(t)) return { form: "the writer form", writer: true };
    return { form: m[5] === undefined ? "a date only" : "a date-time the parser accepts but a writer does not emit" };
  }

  // ---- The parser. Mirrors the order of §4.1, then the card loop of §4.2–§4.7,
  // then type determination and checks of §5. Stops at the first rejection.

  const DEFINED = "ABCDEFGHIJKLMNPQRTUWZ";
  const SINGLE = "ABCDEGHIKLNRUW";
  const ARITY = { A: [2, 3], B: [1, 1], C: [1, 1], D: [1, 1], E: [2, 2], F: [1, 4], G: [1, 1], H: [1, 1], I: [1, 1], J: [1, 2], K: [1, 1], L: [1, 1], M: [1, 1], N: [1, 1], P: [0, 1e9], Q: [1, 2], R: [1, 1], T: [2, 3], U: [0, 1], W: [1, 1], Z: [1, 1] };
  const SETS_TYPE = { A: 6, B: 1, F: 1, Q: 1, R: 1, E: 7, G: 8, H: 8, I: 8, J: 5, K: 5, L: 4, M: 2 };
  const TYPES = {
    1: ["MANIFEST", "checkin", "BCDFNPQRTUZ", "DZ"], 2: ["CLUSTER", "cluster", "MZ", "MZ"],
    3: ["CONTROL", "tag", "DTUZ", "DTUZ"], 4: ["WIKI", "wiki", "CDLNPUWZ", "DLUWZ"],
    5: ["TICKET", "ticket", "DJKUZ", "DJKUZ"], 6: ["ATTACHMENT", "attachment", "ACDNUZ", "ADZ"],
    7: ["EVENT", "technote", "CDENPTUWZ", "DEWZ"], 8: ["FORUM", "forumpost", "DGHINPUWZ", "DUWZ"],
  };
  const CARD_SEC = { A: "4.7.2", B: "4.7.3", C: "4.7.4", D: "4.7.5", E: "4.7.5", F: "4.7.6", G: "4.7.7", H: "4.7.7", I: "4.7.7", J: "4.7.8", K: "4.7.9", L: "4.7.10", M: "4.7.11", N: "4.7.12", P: "4.7.13", Q: "4.7.14", R: "4.7.15", T: "4.7.16", U: "4.7.17", W: "4.7.18", Z: "4.7.19" };

  class Reject extends Error { constructor(sec, msg) { super(msg); this.sec = sec; } }

  const SIG_HEADS = ["-----BEGIN PGP SIGNED MESSAGE-----", "-----BEGIN SSH SIGNED MESSAGE-----"];
  const SIG_TAILS = ["\n-----BEGIN PGP SIGNATURE----", "\n-----BEGIN SSH SIGNATURE----"];

  // §4.1.1. Returns [start, end, kind] of the stripped content.
  function stripWrapper(b) {
    const head = oct(b, 0, Math.min(34, b.length));
    const kind = SIG_HEADS.findIndex((h) => h === head);
    if (kind < 0) return [0, b.length, null];
    let start = -1;
    for (let i = 0; i + 1 < b.length; i++) {
      if (b[i] !== 10) continue;
      if (b[i + 1] === 10) { start = i + 2; break; }
      if (b[i + 1] === 13 && b[i + 2] === 10) { start = i + 3; break; }
    }
    if (start < 0) return [0, b.length, null];
    let end = b.length;
    for (let i = b.length - 29; i >= start; i--) {
      const s = oct(b, i, i + 29);
      if (SIG_TAILS.includes(s)) { end = i + 1; break; }
    }
    return [start, end, kind ? "SSH" : "PGP"];
  }

  function parseArtifact(bytes) {
    const steps = [], cards = [];
    const res = { steps, cards, ok: false, type: 0, F: [], P: [], B: null, R: null, zState: null, start: 0, end: bytes.length };
    const step = (sec, text, ok = true) => steps.push({ sec, text, ok });
    try {
      if (!bytes.length || bytes[bytes.length - 1] !== 10) throw new Reject("4.1", "The input must be non-empty and end in LF.");
      step("4.1", "Non-empty, and the last byte is LF.");
      const [start, end, sig] = stripWrapper(bytes);
      res.start = start; res.end = end;
      step("4.1.1", sig ? `${sig} signature wrapper removed: the cards are bytes ${start} to ${end - 1}.` : "No signature wrapper.");
      const b = bytes.subarray(start, end), n = b.length;
      if (n < 10 || b[0] < 65 || b[0] > 90 || b[1] !== 32) throw new Reject("4.1", "The stripped content must be at least 10 bytes and start with a letter A–Z, then a space.");
      step("4.1", "Line 1 starts with a card letter and a space.");
      if (n >= 35 && b[n - 35] === 90 && b[n - 34] === 32) {
        const want = md5(b.subarray(0, n - 35)), got = oct(b, n - 33, n - 1);
        if (want !== got) { res.zState = "mismatch"; throw new Reject("6.2", `Z card mismatch: MD5 of the first ${n - 35} bytes is ${want}.`); }
        res.zState = "match";
        step("6.2", `Z card matches the MD5 of the ${n - 35} bytes before it.`);
      } else {
        res.zState = "absent";
        step("6.2", "No Z card in the final 35 bytes. That passes this gate; §5.2 decides later.");
      }

      // Card loop.
      let pos = 0, prev = "", sawE = false, type = 0, typeBy = "", lastF = null, lastJ = null, lastM = null, lastT = null;
      const seen = new Set(), present = new Set();
      while (pos < n) {
        const at = pos, L = String.fromCharCode(b[pos]);
        if (b[pos] < 65 || b[pos] > 90) throw new Reject("4.2.2", `Byte ${start + at} is not a card letter.`);
        if (!DEFINED.includes(L)) throw new Reject("4.2.2", `${L} is not one of the 21 card letters.`);
        if (b[pos + 1] !== 32 && b[pos + 1] !== 10) throw new Reject("4.2", `The byte after ${L} must be a space or LF.`);
        let eol = b.indexOf(10, pos);
        if (eol < 0) throw new Reject("4.2", "A card does not end in LF.");
        const argText = b[pos + 1] === 32 ? oct(b, pos + 2, eol) : "";
        let toks = b[pos + 1] === 32 ? argText.split(" ") : [];
        if (L === "U" && toks.length === 1 && toks[0] === "") toks = [];
        if (toks.some((t) => t === "")) throw new Reject("4.2", `${L} card has an empty token.`);
        const [lo, hi] = ARITY[L];
        if (toks.length > hi) throw new Reject("4.2.1", `${L} card carries ${toks.length} tokens; its grammar allows ${hi}.`);
        if (toks.length < lo) throw new Reject(CARD_SEC[L], `${L} card needs ${lo} token${lo > 1 ? "s" : ""}.`);
        if (L < prev && !(L === "N" && prev === "P" && sawE)) throw new Reject("4.4", `${L} comes after ${prev}: cards must be in letter order.`);
        if (SINGLE.includes(L) && seen.has(L)) throw new Reject("4.5.1", `A second ${L} card. ${L} may appear once.`);
        seen.add(L); present.add(L);
        const card = { L, at: start + at, toks, note: "", sec: CARD_SEC[L] };
        const hash = (t, what) => { if (!isHash(t)) throw new Reject("4.7.1", `${what} must be 40 or 64 hex digits.`); return t; };

        if (L === "W") {
          const m = /^\d*/.exec(toks[0])[0];
          const size = m ? Number(m) : 0;
          if (!Number.isSafeInteger(size)) throw new Reject("4.7.18", "W size overflows.");
          const bodyAt = eol + 1;
          if (bodyAt + size + 1 > n) throw new Reject("4.7.18", `W declares ${size} body bytes, more than remain.`);
          if (b[bodyAt + size] !== 10) throw new Reject("4.7.18", "The byte after the W body must be LF.");
          card.body = oct(b, bodyAt, bodyAt + size);
          card.note = `A body of exactly ${size} bytes follows, located by count${card.body.includes("\n") ? "; it contains line breaks, which are body bytes, not card boundaries" : ""}.`;
          eol = bodyAt + size;
        } else if (L === "A") {
          const name = unescape(toks[0]), target = unescape(toks[1]);
          const f = pathnameFault(name);
          if (f) throw new Reject("4.6.1", `A filename fails: ${f}.`);
          if (!isHash(target) && wikiFault(target)) throw new Reject("4.7.2", "A target is neither a hash nor a wiki name.");
          if (toks[2]) hash(toks[2], "A source");
          card.note = toks[2] ? `Attaches ${short(toks[2])} as “${show(name.split("/").pop())}” to ${isHash(target) ? short(target) : "wiki page “" + show(target) + "”"}.`
            : `Deletes the attachment “${show(name.split("/").pop())}” from ${isHash(target) ? short(target) : "“" + show(target) + "”"}.`;
        } else if (L === "B") {
          res.B = hash(toks[0], "B");
          card.note = `This is a delta manifest. Its F cards are differences from baseline ${short(toks[0])}.`;
        } else if (L === "C") {
          card.note = `Comment: “${show(unescape(toks[0]))}”.`;
        } else if (L === "D" || L === "E") {
          const ts = timestampFault(toks[0]);
          if (ts.fault) throw new Reject("4.6.4", `${L} timestamp: ${ts.fault}.`);
          if (L === "E") { hash(toks[1], "E technote id"); sawE = true; }
          card.note = L === "D" ? `When this was made: ${toks[0]}, ${ts.form}.` : `A technote dated ${toks[0]}, id ${short(toks[1])}.`;
        } else if (L === "F") {
          const name = unescape(toks[0]);
          const f = pathnameFault(name);
          if (f) throw new Reject("4.6.1", `F filename fails: ${f}.`);
          if (lastF !== null && !(name > lastF)) throw new Reject("4.5.2", `F “${show(name)}” is not after “${show(lastF)}” in byte order.`);
          if (toks[1]) hash(toks[1], "F hash");
          else if (res.B === null) throw new Reject("4.7.6", "An F card without a hash needs a B card.");
          const old = toks[3] ? unescape(toks[3]) : null;
          if (old !== null && pathnameFault(old)) throw new Reject("4.6.1", `F old name fails: ${pathnameFault(old)}.`);
          const perm = toks[2] || "";
          const kind = perm.includes("x") ? ", executable" : perm.includes("l") ? ", a symbolic link" : "";
          if (isReserved(name)) {
            card.note = `“${show(name)}” is a reserved name, so this card is dropped from the file set.`;
            card.sec = "4.6.3";
          } else {
            lastF = name;
            type = 1; typeBy = "F";
            res.F.push({ name, hash: toks[1] || null, perm, old });
            card.note = toks[1] ? `File “${show(name)}”${kind}, content ${short(toks[1])} (${algo(toks[1])})${old !== null ? `, renamed from “${show(old)}”` : ""}.`
              : `Delete marker: “${show(name)}” is removed from the baseline's set.`;
          }
        } else if (L === "G" || L === "I") {
          hash(toks[0], L);
          card.note = L === "G" ? `Forum thread root ${short(toks[0])}.` : `In reply to ${short(toks[0])}.`;
        } else if (L === "H") {
          card.note = `Forum thread title “${show(unescape(toks[0]))}”.`;
        } else if (L === "J") {
          if (lastJ !== null && !(toks[0] > lastJ)) throw new Reject("4.5.2", "J cards must be in ascending field-name order.");
          lastJ = toks[0];
          card.note = `Ticket field ${show(toks[0])} = “${show(unescape(toks[1] || ""))}”.`;
        } else if (L === "K") {
          if (!isHex(toks[0], 40)) throw new Reject("4.7.9", "A ticket id is exactly 40 hex digits.");
          card.note = `Ticket ${short(toks[0])}.`;
        } else if (L === "L") {
          const t = unescape(toks[0]), f = wikiFault(t);
          if (f) throw new Reject("4.6.2", `L wiki name fails: ${f}.`);
          card.note = `Wiki page “${show(t)}”.`;
        } else if (L === "M") {
          hash(toks[0], "M");
          if (lastM !== null && !(toks[0] > lastM)) throw new Reject("4.5.2", "M cards must be in ascending hash order.");
          lastM = toks[0];
          card.note = `Cluster member ${short(toks[0])}.`;
        } else if (L === "N") {
          card.note = `Mimetype ${show(unescape(toks[0]))}.`;
        } else if (L === "P") {
          toks.forEach((t) => hash(t, "P"));
          res.P.push(...toks);
          card.note = toks.length ? `Parent ${short(toks[0])}${toks.length > 1 ? `, merged with ${toks.slice(1).map(short).join(", ")}` : ""}.` : "No parents: an empty P card.";
        } else if (L === "Q") {
          if (!"+-".includes(toks[0][0])) throw new Reject("4.7.14", "Q must start with + or -.");
          hash(toks[0].slice(1), "Q");
          if (toks[1]) hash(toks[1], "Q baseline");
          card.note = `${toks[0][0] === "+" ? "Cherry-picks" : "Backs out"} ${short(toks[0].slice(1))}.`;
        } else if (L === "R" || L === "Z") {
          if (!isHex(toks[0], 32)) throw new Reject("6.1", `${L} must be 32 hex digits.`);
          if (L === "R") { res.R = toks[0]; card.note = "MD5 over every file's name, size and content."; card.sec = "6.3"; }
          else {
            if (eol !== n - 1) card.note = "An earlier Z line is ordinary content, covered by the final checksum.";
            else { card.note = `MD5 of the ${n - 35} bytes above.`; card.sec = "6.2"; }
          }
        } else if (L === "T") {
          const name = unescape(toks[0]);
          if (!"+-*".includes(name[0])) throw new Reject("4.7.16", "A tag name must start with +, - or *.");
          if (/^[0-9a-fA-F]*$/.test(name.slice(1))) throw new Reject("4.7.16", "A tag name must not be all hex digits.");
          if (toks[1] !== "*") hash(toks[1], "T target");
          const key = [name, toks[1] === "*" ? "" : toks[1]];
          if (lastT && !(key[0] > lastT[0] || (key[0] === lastT[0] && key[1] > lastT[1]))) throw new Reject("4.5.2", "T cards must be in ascending (name, target) order.");
          lastT = key;
          card.self = toks[1] === "*";
          card.sign = name[0];
          const op = { "+": "Sets", "*": "Propagates", "-": "Cancels" }[name[0]];
          card.note = `${op} tag “${show(name.slice(1))}”${toks[2] ? ` = “${show(unescape(toks[2]))}”` : ""} on ${card.self ? "this artifact" : short(toks[1])}.`;
        } else if (L === "U") {
          card.note = `User: ${toks.length ? show(unescape(toks[0])) : "anonymous (the login is empty)"}.`;
        }
        if (SETS_TYPE[L] && L !== "F") { type = SETS_TYPE[L]; typeBy = L; }
        card.note = card.note.replace(/…\.$/, "…");
        cards.push(card);
        prev = L;
        pos = eol + 1;
      }
      step("4.2", `${cards.length} card${cards.length === 1 ? "" : "s"}, each well formed, in letter order, none repeated that may not repeat.`);

      // §5.3
      let how = `set by its last type-setting card, ${typeBy}`;
      if (!type) {
        type = present.has("C") || res.F.length || res.P.length ? 1 : 3;
        how = "by the fallback, as no card set the type";
      }
      res.type = type;
      const [tname, ext, allowed, required] = TYPES[type];
      step("5.3", `Type ${tname} (“${ext}”), ${how}.`);
      for (const L of present) if (!allowed.includes(L)) throw new Reject("5.2", `${L} is not allowed in a ${tname} artifact.`);
      for (const L of required) if (!present.has(L)) throw new Reject("5.2", `A ${tname} artifact must have a ${L} card.`);
      step("5.2", `Every card is allowed for ${tname}, and ${[...required].join(", ")} are present.`);
      const T = cards.filter((c) => c.L === "T");
      if (type === 3 && T.some((c) => c.self)) throw new Reject("5.4", "A control artifact must not have a self-referential T card.");
      if (type === 7 && T.some((c) => !c.self || c.sign !== "+")) throw new Reject("5.4", "In a technote every T card must be +NAME *.");
      if (type === 8 && present.has("H") && present.has("I")) throw new Reject("5.4", "A forum post cannot have both H and I.");
      if (type === 8 && res.P.length > 1) throw new Reject("5.4", "A forum post has at most one parent.");
      step("5.4", "Per-type checks pass.");
      res.ok = true;
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      steps.push({ sec: e.sec, text: e.message, ok: false });
    }
    return res;
  }

  // §8.2: merge-walk of a delta's F list against its baseline's.
  function mergeWalk(base, delta) {
    const out = [];
    let i = 0, j = 0;
    while (i < base.length || j < delta.length) {
      const a = base[i], d = delta[j];
      if (a && d && a.name === d.name) { if (d.hash) out.push(d); i++; j++; }
      else if (!d || (a && a.name < d.name)) { out.push(a); i++; }
      else { if (d.hash) out.push(d); j++; }
    }
    return out;
  }

  // §6.3.2
  function rValue(files, content) {
    const parts = [];
    for (const f of files) {
      const body = content(f);
      if (body == null) return null;
      parts.push(toBytes(f.name), te.encode(" " + body.length + "\n"), body);
    }
    const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return md5(all);
  }

  // ---- Examples from Appendix A, unfolded per RFC 8792.

  const A12_BODY = "This technote is only for test-purposes.\n\nThe original version of this technote had an empty C-card demonstrating that the C-card in event artifacts are optional. Even when doing a \"fossil rebuild\" using fossil version 1.22, this events displays fine. Of course, making the Timeline Comment non-empty would be better. But nothing in Fossil prevents leaving this line empty, so the C-card could as well be left out.\n";
  const EXAMPLES = [
    { id: "A.1.1", label: "A.1.1 root check-in", files: {},
      text: "C initial\\sempty\\sbaseline\nD 2007-07-21T14:09:59\nP\nR d41d8cd98f00b204e9800998ecf8427e\nU drh\nZ c62e3619f7c41ee77b33f00df8ec26f4\n" },
    { id: "A.1.2", label: "A.1.2 technote",
      text: "C Test\\stech-note\nD 2017-12-06T15:36:24.287\nE 2013-08-26T07:35:00 bfdf42305400f6caa441fa816cb89231e90f8c82\nP 94694585cd2f85f75b4316515bbb09aa7e9acaa5\nN text/x-fossil-wiki\nT +bgcolor * #c0f0ff\nU drh\nW 415\n" + A12_BODY + "\nZ a7789c6da4c12b8feb6e290f3083f5f0\n" },
    { id: "A.3", label: "A.3 three files", files: { "alpha.txt": "hello world\n", "beta.txt": "fossil artifact format\n", "gamma.txt": "R card test\n" },
      text: "C Add\\sthree\\stest\\sfiles\nD 2026-07-02T11:18:42.940\nF alpha.txt a8009a7a528d87778c356da3a55d964719e818666a04e4f960c9e2439e35f138\nF beta.txt 1f6ecac38305308107bc78753cec3b4c390c80e6c1660ac9b5de3273ff479d01\nF gamma.txt 67cef386c3cfbb45365917c591deeca9b5c668da781bc743a5f9157ab8f1ac56\nP 9cacef5c0b7713741534ed096e934d0c95d71db734ba569dbcfe70edf798df2f\nR 95feb799536dc053e7968efb7cdd3ec3\nU drh\nZ bbc0f8f7d682cf02ebcea0ece47347f6\n" },
    { id: "A.4.1", label: "A.4.1 baseline",
      text: "C Baseline:\\sthree\\sfiles\nD 2026-07-02T11:21:49.651\nF file-a.txt b3cd28e8bc79c1cb9876e546eccbbab42df7b0f77c341b4aa5367ea7fa440ac0\nF file-b.txt 780ac49d69af62510e0f2e60ae74457665ababd0ca4acf2a6e61cbce1e86bcec\nF file-c.txt a37be80eddab7fdecfc07fe68d898788b14b3d54d8fd077b5188be57bd397c70\nP 3dc18da551fbdcf5805cb04fb2adf4debf9f12faaaaa66cca9a383d788bfc7f0\nR 06173855f6d58f175132e78ff021ce3a\nU drh\nZ 9456a4a7d875ac24816ce3189b19458b\n" },
    { id: "A.4.2", label: "A.4.2 delta", files: { "file-a.txt": "modified content of file A\n", "file-b.txt": "content of file B\n", "file-d.txt": "new file D\n" },
      text: "B 24b831afb9fff3d3ada94e6d3d3731bd04632e3780ded71a668aa174968a30d2\nC Delta:\\sadd\\sD,\\smodify\\sA,\\sdelete\\sC\nD 2026-07-02T11:21:57.150\nF file-a.txt a61d8bf8fcc44bce875134b1cc61107b3c5dc60411330f11a2b4dc124ebec989\nF file-c.txt\nF file-d.txt 4ff0cf8db40756aaae1eba29e028087ae34bfc678c0d0f1429f481939b752ca6\nP 24b831afb9fff3d3ada94e6d3d3731bd04632e3780ded71a668aa174968a30d2\nR 0d7675864b46dd3f197e988759ac2dfa\nU drh\nZ 7d5f4990cfbfb088a1c585be1979d377\n" },
  ];

  const status = (el, ok, text) => { const s = el("span", "status " + (ok ? "ok" : "bad"), text); return s; };

  // ---- Hero: the A.1.1 manifest as cards and tokens.

  const HERO_NOTES = {
    C: ["The comment card (§4.7.4). On a manifest it is optional.", "The comment, escaped so it holds no spaces: \\s is a space, so it reads “initial empty baseline” (§4.3)."],
    D: ["The date card (§4.7.5). Every manifest needs one.", "When the check-in was made, in the writer form YYYY-MM-DDTHH:MM:SS (§4.6.4)."],
    P: ["The parent card with no tokens. This is the root check-in, so it has no parent, and an empty P card MUST be accepted (§4.7.13)."],
    R: ["The R card: a checksum over every file in the check-in (§6.3).", "There are no files, so this is the MD5 of nothing (A.1.1)."],
    U: ["The user card (§4.7.17).", "The login of whoever made the check-in."],
    Z: ["The Z card: always the final 35 bytes (§4.4).", "MD5 of the 92 bytes above. A reader checks it before it reads a single card (§4.1, §6.2)."],
  };

  function initHero(root, ctx) {
    const box = ctx.$("#af-hero-cards", root), note = ctx.$("#af-hero-note", root);
    if (!box) return;
    const host = box.parentNode, intro = note.textContent;
    for (const line of EXAMPLES[0].text.split("\n").filter(Boolean)) {
      const L = line[0], toks = line.length > 1 ? line.slice(2).split(" ") : [];
      const strip = ctx.el("div", "strip");
      const cell = (cls, text, msg) => {
        const c = ctx.el("span", cls, text);
        c.tabIndex = 0;
        const on = () => { note.textContent = msg; };
        c.addEventListener("mouseenter", on); c.addEventListener("focus", on);
        c.addEventListener("mouseleave", () => { note.textContent = intro; });
        strip.append(c);
      };
      cell("b frame", L, HERO_NOTES[L][0]);
      toks.forEach((t) => cell(L === "Z" ? "b lit" : "b copy", t, HERO_NOTES[L][1]));
      cell("b", "↵", "Every card ends in LF (0x0a), and so does the artifact (§4.1, §4.2).");
      host.insertBefore(strip, box);
    }
    box.remove();
  }

  // ---- §3: name some bytes, verify a name.

  function initName(root, ctx) {
    const inp = ctx.$("#af-name-in", root), cand = ctx.$("#af-name-cand", root);
    const out = ctx.$("#af-name-out", root), st = ctx.$("#af-name-status", root), why = ctx.$("#af-name-why", root);
    inp.value = EXAMPLES[0].text;
    cand.value = "a28c83647dfa805f05f3204a7e146eb1f0d90505";
    const run = () => {
      const bytes = te.encode(inp.value), s1 = sha1(bytes), s3 = sha3(bytes), c = cand.value.trim();
      out.textContent = `SHA-1     ${s1}\nSHA3-256  ${s3}`;
      let ok = false, msg;
      if (c.length !== 40 && c.length !== 64) msg = `${c.length} characters. A name is 40 or 64, so this never verifies (§3.2).`;
      else if (!/^[0-9a-fA-F]+$/.test(c)) msg = "Not hexadecimal, so it never verifies (§3.4).";
      else if (/[A-F]/.test(c)) msg = "It has an uppercase digit. Valid names are lowercase, so it never verifies (§3.3).";
      else {
        const want = c.length === 40 ? s1 : s3;
        ok = want === c;
        msg = `${c.length} digits, so compared with the ${c.length === 40 ? "SHA-1" : "SHA3-256"} digest${ok ? "" : ", which differs"} (§3.4). ${bytes.length} bytes.`;
      }
      st.replaceChildren(status(ctx.el, ok, ok ? "verifies" : "does not verify"));
      why.textContent = msg;
    };
    inp.addEventListener("input", run); cand.addEventListener("input", run);
    run();
  }

  // ---- §4.3–4.6: decode a token and run the name predicates on it.

  function initToken(root, ctx) {
    const inp = ctx.$("#af-tok-in", root), dec = ctx.$("#af-tok-dec", root), rows = ctx.$("#af-tok-rows", root), tries = ctx.$("#af-tok-try", root);
    const run = () => {
      const wire = oct(te.encode(inp.value)), d = unescape(wire);
      const vis = [...show(d)].map((ch) => { const c = ch.codePointAt(0); return c < 0x20 ? String.fromCodePoint(0x2400 + c) : c === 0x7f ? "␡" : ch; }).join("");
      dec.textContent = wire.includes(" ") ? "A token cannot contain a space; on the wire a space ends it (§4.2). Write it as \\s." : `decoded  “${vis}”  ${d.length} byte${d.length === 1 ? "" : "s"}`;
      const p = pathnameFault(d), w = p || writerFault(d), k = wikiFault(d), r = isReserved(d);
      const tests = [
        ["Pathname, as a parser checks it", "4.6.1", !p, p ? `rejected: ${p}` : "accepted"],
        ["Pathname, as a writer may create it", "4.6.1", !w, w ? `not allowed: ${w}` : "allowed"],
        ["Wiki name (L card, A target)", "4.6.2", !k, k ? `rejected: ${k}` : "accepted"],
        ["Reserved F filename", "4.6.3", !r, r ? "reserved: the F card is silently dropped" : "not reserved"],
      ];
      rows.replaceChildren(...tests.map(([rule, sec, ok, text]) => {
        const tr = ctx.el("tr");
        const res = ctx.el("td");
        res.append(status(ctx.el, ok, text));
        tr.append(ctx.el("td", null, rule), ctx.el("td", "num", sec), res);
        return tr;
      }));
    };
    for (const t of ["docs/read\\sme.txt", "x_FOSSIL_-wal", "sub/.fslckout", "a/../b.txt", "notes\\\\draft", "\\s\\sHome", "Front\\sPage"]) {
      const b = ctx.el("button", "btn", t);
      b.type = "button";
      b.addEventListener("click", () => { inp.value = t; run(); });
      tries.append(b);
    }
    inp.addEventListener("input", run);
    run();
  }

  // ---- The inspector.

  function initInspector(root, ctx) {
    const $ = (s) => ctx.$(s, root), el = ctx.el;
    const inp = $("#af-insp-in"), pick = $("#af-insp-pick"), src = $("#af-insp-src");
    const st = $("#af-insp-status"), stats = $("#af-insp-stats"), cardRows = $("#af-insp-cards"), stepRows = $("#af-insp-steps"), names = $("#af-insp-names");
    const state = { source: null, original: "", buttons: [] };
    const byName = new Map();
    for (const ex of EXAMPLES) { const b = te.encode(ex.text); byName.set(sha1(b), ex); byName.set(sha3(b), ex); }

    const tok = (t) => {
      const m = /^([+-]?)([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.exec(t);
      return m ? m[1] + m[2].slice(0, 10) + "…" : t.length > 48 ? t.slice(0, 46) + "…" : t;
    };
    const lineFor = (c) => (c.L === "W" ? `W ${c.toks[0]} + ${c.body.length}-byte body` : [c.L, ...c.toks.map(tok)].join(" "));

    function run() {
      const bytes = te.encode(inp.value), res = parseArtifact(bytes);
      const s = state.source;
      st.replaceChildren(status(el, res.ok, res.ok ? `accepted: ${TYPES[res.type][0]}` : "rejected"));
      stats.replaceChildren();
      const stat = (k, v) => { const sp = el("span"); sp.append(el("b", null, v), " " + k); stats.append(sp); };
      stat("bytes", String(bytes.length));
      stat("cards", String(res.cards.length));
      if (res.zState) stat("Z card", res.zState);
      cardRows.replaceChildren(...res.cards.map((c) => {
        const tr = el("tr");
        tr.append(el("td", "num", lineFor(c)), el("td", null, c.note), el("td", "num", c.sec));
        return tr;
      }));
      stepRows.replaceChildren(...res.steps.map((x) => {
        const tr = el("tr"), r = el("td");
        r.append(status(el, x.ok, x.ok ? "pass" : "reject"));
        tr.append(el("td", null, x.text), el("td", "num", x.sec), r);
        return tr;
      }));
      // Beyond parsing: the name (§3), the rebuilt file set (§8.2), and R (§6.3).
      const lines = [`SHA-1     ${sha1(bytes)}`, `SHA3-256  ${sha3(bytes)}`];
      if (s && s.uuid) {
        const mine = s.uuid.length === 64 ? sha3(bytes) : sha1(bytes);
        lines.push(mine === s.uuid ? `stored as ${s.uuid.slice(0, 16)}…, which is its ${algo(s.uuid)} hash (§3.1)` : `stored as ${s.uuid.slice(0, 16)}…; these bytes no longer hash to that name (§3.4)`);
      }
      if (res.ok && res.type === 1) {
        let files = res.F, base = null;
        if (res.B) {
          base = s && s.baseline ? s.baseline(res.B) : null;
          if (base && base.ok) {
            files = mergeWalk(base.F, res.F);
            lines.push(`rebuilt with baseline ${short(res.B)} (§8.2): ${files.map((f) => show(f.name)).join(", ")}`);
          } else {
            files = null;
            lines.push(`baseline ${short(res.B)} is not available here, so the file set cannot be rebuilt (§8.3)`);
          }
        }
        if (res.R && files && s && s.content) {
          const r = rValue(files, s.content);
          if (r === null) lines.push("R card: the file contents are not available here, so it cannot be recomputed");
          else lines.push(`R over ${files.length} file${files.length === 1 ? "" : "s"} is ${r}: ${r === res.R ? "it matches" : "it differs"} (§6.3.2)`);
        }
      }
      names.textContent = lines.join("\n");
    }

    function load(source, text, btn) {
      state.source = source; state.original = text;
      inp.value = text;
      src.textContent = source.caption;
      for (const b of state.buttons) b.classList.toggle("primary", b === btn);
      run();
    }

    function addButton(label, onClick) {
      const b = el("button", "btn", label);
      b.type = "button";
      b.addEventListener("click", () => onClick(b));
      pick.append(b);
      state.buttons.push(b);
      return b;
    }

    const exampleBaseline = (h) => { const ex = byName.get(h); return ex ? parseArtifact(te.encode(ex.text)) : null; };
    for (const ex of EXAMPLES) {
      const src = { caption: `Example from Appendix ${ex.id}`, baseline: exampleBaseline,
        content: (f) => (ex.files && show(f.name) in ex.files ? te.encode(ex.files[show(f.name)]) : null) };
      const b = addButton(ex.label, (btn) => load(src, ex.text, btn));
      if (ex.id === "A.1.1") state.first = () => load(src, ex.text, b);
    }

    inp.addEventListener("input", run);
    $("#af-insp-reset").addEventListener("click", () => { inp.value = state.original; run(); });
    // Edits that keep a valid Z card, so the later rules get a turn.
    const reZ = (text) => {
      const m = /Z [0-9a-fA-F]{32}\n$/.exec(text);
      return m ? text.slice(0, m.index) + "Z " + md5(te.encode(text.slice(0, m.index))) + "\n" : text;
    };
    $("#af-insp-swap").addEventListener("click", () => {
      const lines = inp.value.split("\n");
      const i = lines.findIndex((l, k) => k + 1 < lines.length && /^[A-Z]/.test(lines[k + 1]) && l[0] && l[0] !== lines[k + 1][0]);
      if (i < 0) return;
      [lines[i], lines[i + 1]] = [lines[i + 1], lines[i]];
      inp.value = reZ(lines.join("\n"));
      run();
    });
    $("#af-insp-flip").addEventListener("click", () => {
      const t = inp.value, i = t.indexOf("\n") - 1;
      if (i < 2) return;
      const c = t[i] === "x" ? "y" : "x";
      inp.value = t.slice(0, i) + c + t.slice(i + 1);
      run();
    });
    state.addButton = addButton; state.load = load;
    state.first();
    return state;
  }

  let inspector = null;

  function init(root, ctx) {
    initHero(root, ctx);
    initName(root, ctx);
    initToken(root, ctx);
    inspector = initInspector(root, ctx);
  }

  // Once the repository is open: the draft's own check-in manifests.
  function onRepo(api, ctx) {
    if (!inspector) return;
    const cache = new Map();
    const text = (u) => { if (!cache.has(u)) cache.set(u, ctx.P(api.artifact(u)).text); return cache.get(u); };
    const checkins = ctx.P(api.timeline()).slice(0, 8);
    let first = null;
    checkins.forEach((ci, k) => {
      const day = new Date(ci.time).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
      const source = {
        uuid: ci.uuid,
        caption: `Check-in ${ci.uuid.slice(0, 10)} from this draft's repository, ${day}`,
        baseline: (h) => { try { return parseArtifact(te.encode(text(h))); } catch (e) { return null; } },
        content: (f) => { try { return te.encode(ctx.P(api.read(ci.uuid, show(f.name))).text); } catch (e) { return null; } },
      };
      const b = inspector.addButton(`${k === 0 ? "latest " : ""}${ci.uuid.slice(0, 10)}`, (btn) => inspector.load(source, text(ci.uuid), btn));
      if (k === 0) first = () => inspector.load(source, text(ci.uuid), b);
    });
    if (first) first();
  }

  window.RFC_TOOLS = window.RFC_TOOLS || {};
  window.RFC_TOOLS.af = { init, onRepo };
})();
