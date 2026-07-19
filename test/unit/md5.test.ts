/**
 * Unit tests for the pure-JS MD5 (src/md5.ts).
 *
 * Correctness matters for deletion safety: the reconciler compares this hash
 * against Drive's md5Checksum. The output must be byte-identical to Node's
 * `createHash("md5")`. We pin it against the canonical RFC 1321 test vectors
 * plus a binary and a large-buffer case (multi-block + padding edge cases).
 *
 * Format: AAA.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { md5Hex } from "../../src/md5";

/** Encode a string to an ArrayBuffer (UTF-8). */
function buf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

describe("md5Hex — RFC 1321 test vectors", () => {
  const vectors: Array<[string, string]> = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "d174ab98d277d9f5a5611c2c9f419d9f",
    ],
    [
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
      "57edf4a22be3c955ac49da2e2107b67a",
    ],
  ];

  for (const [input, expected] of vectors) {
    it(`hashes ${JSON.stringify(input.slice(0, 20))}…`, () => {
      // Act
      const result = md5Hex(buf(input));

      // Assert
      expect(result).toBe(expected);
    });
  }
});

describe("md5Hex — matches Node crypto on binary and large data", () => {
  it("matches Node for arbitrary binary bytes", () => {
    // Arrange: all 256 byte values.
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const expected = createHash("md5").update(Buffer.from(bytes)).digest("hex");

    // Act
    const result = md5Hex(bytes.buffer);

    // Assert
    expect(result).toBe(expected);
  });

  it("matches Node for a large multi-block buffer (spans padding boundaries)", () => {
    // Arrange: 100_003 bytes — deliberately not a multiple of 64.
    const bytes = new Uint8Array(100_003);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const expected = createHash("md5").update(Buffer.from(bytes)).digest("hex");

    // Act
    const result = md5Hex(bytes.buffer);

    // Assert
    expect(result).toBe(expected);
  });

  it("matches Node at each length around the 56/64-byte padding edge", () => {
    // Arrange & Act & Assert: lengths 54..66 exercise the pad-into-next-block case.
    for (let n = 54; n <= 66; n++) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i + 1) & 0xff;
      const expected = createHash("md5")
        .update(Buffer.from(bytes))
        .digest("hex");
      expect(md5Hex(bytes.buffer)).toBe(expected);
    }
  });
});
