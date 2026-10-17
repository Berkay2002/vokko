import { MOCK, REST_BASE, getToken } from "./config";
import { request } from "./rest";

// App icons of Playing activities (docs/api.md "App icons"): POST /app-icons takes a PNG and answers the `app:<sha256>` asset the
// activity carries; GET /app-icons/{hash} is public. The mock keeps the pictures in memory, since an <img> never goes through it.

const HASH = /^[0-9a-f]{64}$/;
const mockIcons = new Map<string, string>();

/** The mock backend remembers an icon as a data URL under its hash. */
export function registerMockAppIcon(hash: string, dataUrl: string): void {
  mockIcons.set(hash, dataUrl);
}

/** Whether the mock backend holds this icon (the real server answers the same question from its table). */
export const hasMockAppIcon = (hash: string): boolean => mockIcons.has(hash);

/** Where the icon with this hash is shown from, built from the validated hash only; null for anything else (or an unknown mock hash). */
export function appIconSrc(hash: string): string | null {
  if (!HASH.test(hash)) return null;
  return MOCK ? (mockIcons.get(hash) ?? null) : `${REST_BASE}/app-icons/${hash}`;
}

/** Uploads a base64 PNG and returns the asset (`app:<hash>`) for `assets.large_image`. Rejects when the server refuses it. */
export async function uploadAppIcon(pngBase64: string): Promise<string> {
  if (MOCK) return (await request<{ asset: string }>("POST", "/app-icons", { png: pngBase64 })).asset;
  const bytes = Uint8Array.from(atob(pngBase64), char => char.charCodeAt(0));
  const token = getToken();
  const response = await fetch(`${REST_BASE}/app-icons`, { method: "POST", headers: { "Content-Type": "image/png", ...(token ? { Authorization: token } : {}) }, body: bytes });
  if (!response.ok) throw new Error(`app icon upload failed: ${response.status}`);
  const { asset } = (await response.json()) as { asset?: unknown };
  if (typeof asset !== "string" || !/^app:[0-9a-f]{64}$/.test(asset)) throw new Error("app icon upload: unexpected answer");
  return asset;
}
