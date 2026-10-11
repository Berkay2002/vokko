// The composer and the inline editor are plain <textarea>s, so mentions are shown as "@Name" / "#channel" and mapped back to
// the wire tokens (<@id>, <@&id>, <#id>) when sending.

export interface MentionToken { display: string; raw: string }

/** Replace wire tokens in `content` with their display form; returns the tokens so `fromDisplay` can reverse them. */
export function toDisplay(content: string, names: { user(id: string): string | null; role(id: string): string | null; channel(id: string): string | null }): { text: string; tokens: MentionToken[] } {
  const tokens: MentionToken[] = [];
  const text = content.replace(/<(@&|@!?|#)(\d+)>/g, (raw, kind: string, id: string) => {
    const name = kind === '@&' ? names.role(id) : kind === '#' ? names.channel(id) : names.user(id);
    if (!name) return raw;
    const display = `${kind === '#' ? '#' : '@'}${name}`;
    tokens.push({ display, raw });
    return display;
  });
  return { text, tokens };
}

/** Longest display names first so "@Ann Marie" wins over "@Ann"; a match must end at a word boundary. */
export function fromDisplay(text: string, tokens: MentionToken[]): string {
  if (tokens.length === 0) return text;
  const sorted = [...tokens].sort((a, b) => b.display.length - a.display.length);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '@' || ch === '#') {
      const hit = sorted.find(t => text.startsWith(t.display, i) && isBoundary(text[i + t.display.length]) && (i === 0 || /\s/.test(text[i - 1] ?? '')));
      if (hit) { out += hit.raw; i += hit.display.length; continue; }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function isBoundary(c: string | undefined): boolean {
  return c === undefined || !/[\p{L}\p{N}_]/u.test(c);
}
