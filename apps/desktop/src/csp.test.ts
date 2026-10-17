import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STREMIO_IMAGE_HOSTS } from "./api/types";

// The CSP only applies in the Tauri app, so a missing host shows up as broken images there and nowhere else. This keeps the
// lists in tauri.conf.json (dev) and release.production.json (packaged) in step with every host the client loads media from.
const tauriDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const readJson = (name: string) => JSON.parse(readFileSync(join(tauriDir, name), "utf8"));
const dev = readJson("tauri.conf.json");
const release = readJson(join("..", "release.production.json"));

/** directive -> sources; a directive the policy leaves out falls back to default-src. */
function parse(csp: string): (directive: string) => string[] {
  const map = new Map(csp.split(";").map(part => part.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources] as const));
  return directive => map.get(directive) ?? map.get("default-src") ?? [];
}

/** Whether a source list lets `url` through (exact origin or `scheme://*.domain` wildcard; 'self' is not a remote origin). */
function allows(sources: string[], url: string): boolean {
  const { protocol, host } = new URL(url);
  return sources.some(source => {
    const match = /^([a-z]+:)\/\/(\*\.)?([^/]+)$/.exec(source);
    if (!match || match[1] !== protocol) return false;
    return match[2] ? host.endsWith(`.${match[3]}`) : host === match[3];
  });
}

// One sample URL per host family the client renders in <img>; each comes from the server or a third party, never 'self'.
const IMAGE_URLS = [
  "https://i.scdn.co/image/ab67616d0000b273", // Spotify art: the server only ever hands out i.scdn.co ids
  "https://media0.giphy.com/media/x/giphy.gif",
  "https://media.giphy.com/media/x/giphy.gif",
  "https://media.tenor.com/a.gif",
  "https://static.klipy.com/a.gif",
  ...STREMIO_IMAGE_HOSTS.map(host => `https://${host}/poster.jpg`),
  "https://live.metahub.space/poster.jpg", // images.metahub.space redirects posters it hasn't cached yet here
];

describe.each([
  ["tauri.conf.json", dev.app.security.csp as string],
  ["release.production.json", release.app.security.csp as string],
])("%s CSP", (_name, csp) => {
  const directive = parse(csp);

  it.each(IMAGE_URLS)("img-src allows %s", url => {
    expect(allows(directive("img-src"), url)).toBe(true);
  });
});

describe("release CSP and the production server", () => {
  const directive = parse(release.app.security.csp);
  // The updater endpoint is the production server; avatars, attachments, emoji, stickers and proxied embed media come from it.
  const server = new URL(release.plugins.updater.endpoints[0]).origin;

  it("loads images, video and audio from the server", () => {
    expect(allows(directive("img-src"), `${server}/avatars/1/a.webp`)).toBe(true);
    expect(allows(directive("img-src"), `${server}/external/abc`)).toBe(true);
    expect(allows(directive("media-src"), `${server}/attachments/1/2/clip.mp4`)).toBe(true);
  });

  it("reaches the server's REST API and gateway", () => {
    expect(allows(directive("connect-src"), `${server}/api/v1/users/@me`)).toBe(true);
    expect(allows(directive("connect-src"), `${server.replace(/^https/, "wss")}/gateway`)).toBe(true);
  });
});
