// Pure helpers for link/invite embeds (unit-tested in embedUtil.test.ts).

const MAX_INVITES = 3;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Vokko's own invite links: `<app host>/invite/<code>` (what the invite modal shows) and the legacy `vokko.gg/<code>`.
// Other services' invite links (discord.gg, ...) are never ours, so they are left as plain links.
function inviteRe(hosts: readonly string[]): RegExp {
  const origins = ['vokko\\.gg', ...hosts.filter(Boolean).map(h => `${escapeRe(h)}\\/invite`)];
  return new RegExp(`(?<![\\w.@-])(?:https?:\\/\\/)?(?:${origins.join('|')})\\/([A-Za-z0-9-]{2,32})(?![A-Za-z0-9-])`, 'gi');
}

/**
 * Invite codes in message text, in order, de-duplicated. `hosts` are the app's own `host[:port]` values
 * (e.g. `location.host`). Ignores code spans, code blocks and `<url>` (embed-suppressed) links.
 */
export function findInviteCodes(content: string, hosts: readonly string[] = []): string[] {
  const visible = content.replace(/```[\s\S]*?```|`[^`\n]*`|<[^>\s]+>/g, ' ');
  const out: string[] = [];
  for (const m of visible.matchAll(inviteRe(hosts))) {
    const code = m[1]!;
    if (!out.includes(code)) out.push(code);
    if (out.length >= MAX_INVITES) break;
  }
  return out;
}

/** http(s) URLs only: embed data is server-supplied and must never become a `javascript:` or `data:` link. */
export function safeHttpUrl(url: string | undefined | null, base = 'http://localhost'): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

/** Embed colour int (0xRRGGBB) → CSS hex, or null when absent. */
export function embedColor(color: number | undefined | null): string | null {
  if (color === undefined || color === null || !Number.isFinite(color)) return null;
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

export const isVideoUrl = (url: string): boolean => /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url);
