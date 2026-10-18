/**
 * Click-to-play embed players: an unfurl's `video.url` on one of these exact https hosts plays in an iframe inside the chat.
 * Everything else keeps the poster that opens the link.
 */
const PLAYERS = new Map<string, (url: URL) => string | null>(Object.entries({
  // YouTube always plays from the no-cookie host.
  'www.youtube.com': youtube,
  'youtube.com': youtube,
  'www.youtube-nocookie.com': youtube,
  'player.vimeo.com': url => (/^\/video\/\d+$/.test(url.pathname) ? withAutoplay(url).toString() : null),
  'open.spotify.com': url => (/^\/embed\/(track|album|playlist|episode|show|artist)\/[A-Za-z0-9]+$/.test(url.pathname) ? url.toString() : null),
}));

function youtube(url: URL): string | null {
  const id = /^\/embed\/([A-Za-z0-9_-]{6,20})$/.exec(url.pathname)?.[1];
  if (!id) return null;
  const out = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
  out.search = url.search;
  return withAutoplay(out).toString();
}

function withAutoplay(url: URL): URL {
  url.searchParams.set('autoplay', '1');
  return url;
}

/** The iframe src for a player embed, or null: not an allow-listed player, or "Display images and videos from links" is off. */
export function playerSrc(videoUrl: string | null | undefined, inlineMedia: boolean): string | null {
  if (!inlineMedia || !videoUrl) return null;
  let url: URL;
  try { url = new URL(videoUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  return PLAYERS.get(url.hostname)?.(url) ?? null;
}
