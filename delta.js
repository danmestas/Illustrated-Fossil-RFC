// Fossil delta format: encoder ported from Fossil's src/delta.c (delta_create),
// decoder following draft-fossil-delta-format-00 Section 4.
const Delta = (() => {
  const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~";
  const VALUE = new Int8Array(256).fill(-1);
  for (let i = 0; i < 64; i++) VALUE[DIGITS.charCodeAt(i)] = i;
  const NHASH = 16;

  function putInt(v) {
    if (v === 0) return "0";
    let s = "";
    for (; v > 0; v = Math.floor(v / 64)) s = DIGITS[v % 64] + s;
    return s;
  }
  const digitCount = (v) => { let i = 1; for (let x = 64; v >= x; i++, x *= 64) {} return i; };

  // Big-endian 32-bit word sum, wrapping at 2^32, short tail shifted into the high bytes.
  function checksum(z) {
    let sum = 0, i = 0;
    const whole = z.length & ~3;
    for (; i < whole; i += 4) sum = (sum + ((z[i] << 24) >>> 0) + (z[i + 1] << 16) + (z[i + 2] << 8) + z[i + 3]) >>> 0;
    const n = z.length & 3;
    if (n >= 3) sum = (sum + (z[i + 2] << 8)) >>> 0;
    if (n >= 2) sum = (sum + (z[i + 1] << 16)) >>> 0;
    if (n >= 1) sum = (sum + ((z[i] << 24) >>> 0)) >>> 0;
    return sum;
  }

  // Rolling hash over 16 bytes; Fossil hashes C chars, signed on most hosts.
  const sc = (b) => (b > 127 ? b - 256 : b);
  function hashOnce(z, o) {
    let a = sc(z[o]) & 0xffff, b = a;
    for (let i = 1; i < NHASH; i++) { a = (a + sc(z[o + i])) & 0xffff; b = (b + a) & 0xffff; }
    return (a | (b << 16)) >>> 0;
  }
  class Hash {
    constructor(z, o) {
      let a = sc(z[o]) & 0xffff, b = a;
      for (let i = 1; i < NHASH; i++) { a = (a + sc(z[o + i])) & 0xffff; b = (b + a) & 0xffff; }
      this.a = a; this.b = b; this.i = 0; this.z = Array.from(z.subarray(o, o + NHASH), sc);
    }
    next(c) {
      c = sc(c);
      const old = this.z[this.i];
      this.z[this.i] = c;
      this.i = (this.i + 1) & (NHASH - 1);
      this.a = (this.a - old + c) & 0xffff;
      this.b = (this.b - NHASH * old + this.a) & 0xffff;
    }
    value() { return (this.a | (this.b << 16)) >>> 0; }
  }

  // Returns {bytes, segments} where segments describe what was emitted.
  function create(src, out) {
    const parts = [], segs = [];
    const enc = new TextEncoder();
    const lit = (from, n) => {
      parts.push(enc.encode(putInt(n) + ":"), out.subarray(from, from + n));
      segs.push({ type: "literal", count: n, at: from });
    };
    const copy = (n, ofst, at) => {
      parts.push(enc.encode(putInt(n) + "@" + putInt(ofst) + ","));
      segs.push({ type: "copy", count: n, offset: ofst, at });
    };
    parts.push(enc.encode(putInt(out.length) + "\n"));
    const lenSrc = src.length, lenOut = out.length;
    if (lenSrc <= NHASH) {
      if (lenOut > 0) lit(0, lenOut); else { parts.push(enc.encode("0:")); segs.push({ type: "literal", count: 0, at: 0 }); }
    } else {
      const nHash = Math.floor(lenSrc / NHASH);
      const collide = new Int32Array(nHash).fill(-1), landmark = new Int32Array(nHash).fill(-1);
      for (let i = 0; i < lenSrc - NHASH; i += NHASH) {
        const hv = hashOnce(src, i) % nHash;
        collide[i / NHASH] = landmark[hv];
        landmark[hv] = i / NHASH;
      }
      let base = 0;
      while (base + NHASH < lenOut) {
        const h = new Hash(out, base);
        let i = 0, bestCnt = 0, bestOfst = 0, bestLitsz = 0;
        for (;;) {
          let limit = 250;
          let iBlock = landmark[h.value() % nHash];
          while (iBlock >= 0 && limit-- > 0) {
            const iSrc = iBlock * NHASH;
            let y = base + i, x;
            const limitX = lenSrc - iSrc <= lenOut - y ? lenSrc : iSrc + lenOut - y;
            for (x = iSrc; x < limitX; x++, y++) if (src[x] !== out[y]) break;
            const j = x - iSrc - 1;
            let k;
            for (k = 1; k < iSrc && k <= i; k++) if (src[iSrc - k] !== out[base + i - k]) break;
            k--;
            const ofst = iSrc - k, cnt = j + k + 1, litsz = i - k;
            const sz = digitCount(i - k) + digitCount(cnt) + digitCount(ofst) + 3;
            if (cnt >= sz && cnt > bestCnt) { bestCnt = cnt; bestOfst = ofst; bestLitsz = litsz; }
            iBlock = collide[iBlock];
          }
          if (bestCnt > 0) {
            if (bestLitsz > 0) { lit(base, bestLitsz); base += bestLitsz; }
            copy(bestCnt, bestOfst, base);
            base += bestCnt;
            break;
          }
          if (base + i + NHASH >= lenOut) { lit(base, lenOut - base); base = lenOut; break; }
          h.next(out[base + i + NHASH]);
          i++;
        }
      }
      if (base < lenOut) lit(base, lenOut - base);
    }
    parts.push(enc.encode(putInt(checksum(out)) + ";"));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
    return { bytes, segments: segs };
  }

  // Applies a delta, recording every step. Rejections cite the RFC Section 4 condition.
  function apply(src, delta) {
    const steps = [];
    const fail = (cond, msg, at) => ({ ok: false, cond, msg, at, steps });
    if (delta.length === 0) return fail(0, "The delta is zero bytes long.", 0);
    let p = 0;
    const readInt = () => {
      const start = p; let v = 0;
      while (p < delta.length && VALUE[delta[p]] >= 0) { v = v * 64 + VALUE[delta[p]]; p++; }
      return { v, start, end: p };
    };
    const hdr = readInt();
    if (p >= delta.length) return fail(2, "Integer accumulation ran off the end of the delta.", p);
    if (delta[p] !== 0x0a) return fail(1, "The header integer is not followed by 0x0a.", p);
    p++;
    const limit = hdr.v;
    steps.push({ type: "header", from: 0, to: p, value: limit });
    const outBuf = new Uint8Array(limit);
    let pos = 0;
    while (p < delta.length) {
      const segStart = p;
      const cnt = readInt();
      if (p >= delta.length) return fail(2, "Integer accumulation ran off the end of the delta.", p);
      const op = delta[p];
      if (op === 0x40) {
        p++;
        const ofst = readInt();
        if (p >= delta.length || delta[p] !== 0x2c) return fail(3, "The copy segment has no comma after its offset.", p);
        p++;
        if (ofst.v + cnt.v > src.length) return fail(5, `Copy of ${cnt.v} bytes at offset ${ofst.v} runs past the ${src.length}-byte source.`, segStart);
        if (pos + cnt.v > limit) return fail(4, "The copy would write past the declared target length.", segStart);
        outBuf.set(src.subarray(ofst.v, ofst.v + cnt.v), pos);
        steps.push({ type: "copy", from: segStart, to: p, count: cnt.v, offset: ofst.v, outAt: pos });
        pos += cnt.v;
      } else if (op === 0x3a) {
        p++;
        if (cnt.v > delta.length - p) return fail(7, "The literal count is larger than the bytes left in the delta.", segStart);
        if (pos + cnt.v > limit) return fail(6, "The literal would write past the declared target length.", segStart);
        outBuf.set(delta.subarray(p, p + cnt.v), pos);
        p += cnt.v;
        steps.push({ type: "literal", from: segStart, to: p, count: cnt.v, outAt: pos });
        pos += cnt.v;
      } else if (op === 0x3b) {
        p++;
        if (pos !== limit) return fail(9, `The output is ${pos} bytes at the trailer, not the declared ${limit}.`, segStart);
        const sum = checksum(outBuf);
        steps.push({ type: "trailer", from: segStart, to: p, value: cnt.v, computed: sum });
        if (sum !== cnt.v) return fail(8, `Checksum mismatch: trailer says ${cnt.v}, target sums to ${sum}.`, segStart);
        return { ok: true, out: outBuf, steps, end: p };
      } else {
        return fail(10, `Byte 0x${op.toString(16).padStart(2, "0")} is not an opcode (@ : ;).`, p);
      }
    }
    return fail(11, "The delta ends without a ';' trailer.", p);
  }

  function decodeInt(s) {
    let v = 0n; const digits = [];
    for (const ch of s) {
      const d = DIGITS.indexOf(ch);
      if (d < 0) return { error: `"${ch}" is not a base-64 digit`, digits };
      v = v * 64n + BigInt(d);
      digits.push({ ch, d, v });
    }
    return { value: v, digits };
  }

  return { DIGITS, putInt, checksum, create, apply, decodeInt };
})();
if (typeof module === "object") module.exports = Delta;
