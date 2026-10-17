// Mock of POST /app-icons (docs/api.md "App icons"): same checks and the same `app:<hash>` answer, but the picture is kept as it was
// sent (no 64x64 re-encode: a browser cannot decode a PNG synchronously) and the hash is a stand-in for SHA-256.

import { registerMockAppIcon } from "../appIcons";
import { fail } from "./ops";
import { route, str } from "./router";

/** Same limit as the server. */
const MAX_BYTES = 128 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 64 hex digits from four FNV-1a passes with different seeds: stable for the same bytes, which is all the mock needs. */
export function mockIconHash(bytes: Uint8Array): string {
  let out = "";
  for (let pass = 0; pass < 8; pass++) {
    let h = (0x811c9dc5 ^ (pass * 0x9e3779b1)) >>> 0;
    for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

route("POST", "/app-icons", ({ body }) => {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(str(body.png) ?? ""), char => char.charCodeAt(0));
  } catch {
    return fail(400, 50035, "Invalid Form Body", { body: { _errors: [{ code: "INVALID", message: "Must be a PNG image (Content-Type: image/png)." }] } });
  }
  if (bytes.length > MAX_BYTES) fail(413, 40005, "Request entity too large");
  if (bytes.length < PNG_MAGIC.length || PNG_MAGIC.some((byte, i) => bytes[i] !== byte)) {
    fail(400, 50035, "Invalid Form Body", { body: { _errors: [{ code: "INVALID", message: "Must be a PNG image of at most 512x512 pixels." }] } });
  }
  const hash = mockIconHash(bytes);
  registerMockAppIcon(hash, `data:image/png;base64,${str(body.png)}`);
  return { asset: `app:${hash}` };
});
