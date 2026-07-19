/**
 * Pure-JS MD5 (RFC 1321), operating on an ArrayBuffer.
 *
 * Why not Node `crypto`: the plugin must run on Obsidian mobile (Capacitor
 * WebView), where the Node `crypto` module is unavailable. WebCrypto
 * (`crypto.subtle`) only offers SHA, not MD5 — but Google Drive reports
 * `md5Checksum`, which the reconciler compares against. Hence a self-contained
 * MD5 with no runtime dependency.
 *
 * Output is byte-identical to Node's `createHash("md5").digest("hex")`; the
 * known-vector tests in `test/unit/md5.test.ts` guard this (deletion safety
 * depends on the hash comparison being correct).
 */

/** MD5 of an ArrayBuffer, as a lowercase hex string. */
export function md5Hex(buf: ArrayBuffer): string {
  return hexFromWords(md5(new Uint8Array(buf)));
}

// --- Core algorithm (little-endian, 32-bit word arithmetic) --------------

function md5(bytes: Uint8Array): number[] {
  const originalLenBits = bytes.length * 8;

  // Pad: append 0x80, then zeros, until length ≡ 56 (mod 64), then the
  // 64-bit little-endian bit length.
  const withPad = ((bytes.length + 8) >> 6 << 6) + 64;
  const msg = new Uint8Array(withPad);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  // 64-bit length, little-endian. JS bitwise is 32-bit; write low + high word.
  const lenLow = originalLenBits >>> 0;
  const lenHigh = Math.floor(originalLenBits / 0x100000000) >>> 0;
  writeWordLE(msg, withPad - 8, lenLow);
  writeWordLE(msg, withPad - 4, lenHigh);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Array<number>(16);
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) {
      M[i] = readWordLE(msg, off + i * 4);
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        f = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        f = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + f + K[i] + M[g]) | 0;
      B = (B + rotl(sum, S[i])) | 0;
      A = tmp;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  return [a0, b0, c0, d0];
}

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

function readWordLE(buf: Uint8Array, off: number): number {
  return (
    (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
  );
}

function writeWordLE(buf: Uint8Array, off: number, word: number): void {
  buf[off] = word & 0xff;
  buf[off + 1] = (word >>> 8) & 0xff;
  buf[off + 2] = (word >>> 16) & 0xff;
  buf[off + 3] = (word >>> 24) & 0xff;
}

/** The four 32-bit result words → 32-char little-endian hex digest. */
function hexFromWords(words: number[]): string {
  let out = "";
  for (const word of words) {
    for (let b = 0; b < 4; b++) {
      const byte = (word >>> (b * 8)) & 0xff;
      out += byte.toString(16).padStart(2, "0");
    }
  }
  return out;
}

// Per-round shift amounts.
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
];

// Constants K[i] = floor(2^32 * abs(sin(i + 1))).
const K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
  0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
  0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
  0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];
