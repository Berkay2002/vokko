// Synchronous TOTP (RFC 6238, HMAC-SHA1) for the mock backend, whose routes cannot await Web Crypto.

function sha1(bytes: Uint8Array): Uint8Array {
  const length = bytes.length;
  const words = new Uint32Array((((length + 8) >> 6) + 1) * 16);
  for (let i = 0; i < length; i += 1) words[i >> 2]! |= bytes[i]! << (24 - (i % 4) * 8);
  words[length >> 2]! |= 0x80 << (24 - (length % 4) * 8);
  words[words.length - 1] = length * 8;
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 80; t += 1) {
      if (t < 16) w[t] = words[block + t]!;
      else {
        const x = w[t - 3]! ^ w[t - 8]! ^ w[t - 14]! ^ w[t - 16]!;
        w[t] = (x << 1) | (x >>> 31);
      }
    }
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let t = 0; t < 80; t += 1) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]!) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  [h0, h1, h2, h3, h4].forEach((h, i) => {
    out[i * 4] = h >>> 24;
    out[i * 4 + 1] = (h >>> 16) & 255;
    out[i * 4 + 2] = (h >>> 8) & 255;
    out[i * 4 + 3] = h & 255;
  });
  return out;
}

function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? sha1(key) : key);
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 20);
  for (let i = 0; i < 64; i += 1) {
    inner[i] = block[i]! ^ 0x36;
    outer[i] = block[i]! ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha1(inner), 64);
  return sha1(outer);
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(text: string): Uint8Array | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of text.replace(/[\s=]/g, "").toUpperCase()) {
    const value = ALPHABET.indexOf(c);
    if (value < 0) return null;
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

export function totpAt(key: Uint8Array, step: number): string {
  const counter = new Uint8Array(8);
  let value = step;
  for (let i = 7; i >= 0; i -= 1) {
    counter[i] = value & 255;
    value = Math.floor(value / 256);
  }
  const digest = hmacSha1(key, counter);
  const offset = digest[19]! & 15;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

/** The step a code matches now (±1), or null. */
export function matchingStep(secret: string, code: string, nowMs = Date.now()): number | null {
  const key = base32Decode(secret);
  if (!key || !/^\d{6}$/.test(code)) return null;
  const now = Math.floor(nowMs / 30_000);
  for (const step of [now - 1, now, now + 1]) if (totpAt(key, step) === code) return step;
  return null;
}
