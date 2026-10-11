// Live markdown tokenizer for the composer (CMP-011).
//
// Turns the draft source into lines of styled segments that partition the source exactly: the concatenated segment text of the
// concatenated lines (joined with "\n") is the source, so the editor can render it and map a caret between DOM and source offsets.
// The rules mirror `chat/markdown/parse.ts` (block regexes, fence handling, the delimiter-stack emphasis algorithm, link and
// mention syntax) so what the composer previews is what a sent message renders. Nothing here touches the DOM.

/** Style bits of a segment. A segment can carry several (bold inside a spoiler, ...). */
export const Mark = {
  Bold: 1,
  Italic: 2,
  Underline: 4,
  Strike: 8,
  Spoiler: 16,
  Code: 32,
  /** Delimiters and prefixes (`**`, `> `, `# `, ...): shown dimmed. */
  Syntax: 64,
  Link: 128,
  Mention: 256,
  Emoji: 512,
  /** The `> ` prefix of a quote line: drawn as a bar. */
  QuoteMark: 1024,
} as const;

/** Whole-line properties. */
export const LineFlag = {
  Quote: 1,
  /** Inside a fenced code block (fence lines included). */
  Code: 2,
  Subtext: 4,
  List: 8,
  Heading: 16,
  /** Quote line that has no `> ` prefix of its own (the rest of a `>>> ` quote). */
  QuoteBody: 32,
} as const;

export type TimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

/** A token that is shown as one chip and edited as one unit (raw `<@id>`, `<:name:id>`, `<t:unix>`, a resolved `:shortcode:`). */
export type Atom =
  | { kind: 'user' | 'role' | 'channel'; id: string }
  | { kind: 'emoji'; name: string; id: string; animated: boolean }
  | { kind: 'timestamp'; unix: number; style: TimestampStyle }
  | { kind: 'shortcode'; name: string; unicode: string };

export interface Segment {
  /** Source offsets, `end` exclusive. */
  start: number;
  end: number;
  marks: number;
  /** highlight.js class of a code-block token, or null. */
  hl: string | null;
  atom: Atom | null;
}

export interface EditorLine {
  /** Source offsets of the line's text (the "\n" is not part of it). */
  start: number;
  end: number;
  flags: number;
  segments: Segment[];
}

export interface HighlightRange {
  start: number;
  end: number;
  cls: string;
}

export interface TokenizeOptions {
  /** `:name:` shortcodes that resolve to a unicode emoji (shown as chips). */
  shortcodes?: ReadonlyMap<string, string>;
  /** Display forms of mentions picked from the autocomplete (`@Alice`, `#general`): shown as mention chips. */
  mentions?: readonly string[];
  /** Syntax highlighting of a code block's body; offsets are relative to `code`. */
  highlight?: (code: string, lang: string | null) => HighlightRange[];
}

/** Above this length styling is skipped (the composer is limited to a few thousand characters anyway). */
export const MAX_STYLED_LENGTH = 20_000;

const HEADING_RE = /^(#{1,3}) +(\S.*)$/;
const SUBTEXT_RE = /^-# +(\S.*)$/;
const UL_RE = /^ *[-*] +(\S.*)$/;
const OL_RE = /^ *(\d{1,9})\. +(\S.*)$/;
const FENCE_LANG_RE = /^([A-Za-z0-9_+\-.#]+)\n/;

const MAX_URL = 2048;
const ASCII_PUNCT_RE = /[!-/:-@[-`{-~]/;
const UNI_PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /\s/;
const ALNUM_RE = /[A-Za-z0-9]/;
const SHORTCODE_RE = /:([A-Za-z0-9_+-]{1,64}):/y;
const USER_RE = /<@!?(\d+)>/y;
const ROLE_RE = /<@&(\d+)>/y;
const CHANNEL_RE = /<#(\d+)>/y;
const TIMESTAMP_RE = /<t:(-?\d{1,15})(?::([tTdDfFR]))?>/y;
const CUSTOM_EMOJI_RE = /<(a?):([A-Za-z0-9_]{2,32}):(\d+)>/y;
const ANGLE_URL_RE = /<(https?:\/\/[^\s<>]+)>/y;
const SAFE_HREF_RE = /^(?:https?:\/\/\S|mailto:\S)/i;
const URL_TRAIL = ".,:;!?'\"*_~|>";

let emojiRe: RegExp | null | undefined;
function getEmojiRe(): RegExp | null {
  if (emojiRe === undefined) {
    try {
      emojiRe = new RegExp('\\p{RGI_Emoji}', 'vy');
    } catch {
      try {
        emojiRe = new RegExp(
          '\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?)*|\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3',
          'uy',
        );
      } catch {
        emojiRe = null;
      }
    }
  }
  return emojiRe;
}

function codePointBefore(s: string, i: number): string {
  if (i <= 0) return '';
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1]!;
}

function codePointAt(s: string, i: number): string {
  if (i >= s.length) return '';
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const l = s.charCodeAt(i + 1);
    if (l >= 0xdc00 && l <= 0xdfff) return s.slice(i, i + 2);
  }
  return s[i]!;
}

const isWs = (c: string) => c === '' || WS_RE.test(c);
const isPunct = (c: string) => c !== '' && (c.length === 1 && c.charCodeAt(0) < 128 ? ASCII_PUNCT_RE.test(c) : UNI_PUNCT_RE.test(c));
const isKeycapTail = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  return c === 0xfe0f || c === 0x20e3;
};

/** `(url)` / `(<url>)` / `(url "title")` starting at s[k] === '('. */
function parseLinkDest(s: string, k: number): { urlStart: number; urlEnd: number; end: number } | null {
  const len = s.length;
  let p = k + 1;
  while (p < len && (s[p] === ' ' || s[p] === '\t')) p++;
  let urlStart: number;
  let urlEnd: number;
  if (s[p] === '<') {
    urlStart = p + 1;
    let q = urlStart;
    while (q < len && q - urlStart < MAX_URL) {
      const c = s[q]!;
      if (c === '>' || c === '<' || c === '\n' || c === ' ' || c === '\t') break;
      q++;
    }
    if (s[q] !== '>') return null;
    urlEnd = q;
    p = q + 1;
  } else {
    urlStart = p;
    let depth = 0;
    while (p < len && p - urlStart < MAX_URL) {
      const c = s[p]!;
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      p++;
    }
    urlEnd = p;
  }
  if (urlEnd === urlStart) return null;
  while (p < len && (s[p] === ' ' || s[p] === '\t')) p++;
  if (s[p] === '"') {
    let q = p + 1;
    while (q < len && q - p < 512 && s[q] !== '"' && s[q] !== '\n') q++;
    if (s[q] !== '"') return null;
    p = q + 1;
    while (p < len && (s[p] === ' ' || s[p] === '\t')) p++;
  }
  if (s[p] !== ')') return null;
  return { urlStart, urlEnd, end: p + 1 };
}

// ---------------------------------------------------------------------------------------------
// painting
// ---------------------------------------------------------------------------------------------

interface Ctx {
  source: string;
  opts: TokenizeOptions;
  marks: Uint16Array;
  hlIndex: Uint16Array;
  hlNames: string[];
  atoms: Map<number, { end: number; atom: Atom }>;
  lineStarts: number[];
  lineFlags: number[];
  mentions: readonly string[];
}

function paint(c: Ctx, start: number, end: number, marks: number): void {
  const e = Math.min(end, c.marks.length);
  for (let i = Math.max(0, start); i < e; i++) c.marks[i] = (c.marks[i] ?? 0) | marks;
}

function paintHl(c: Ctx, start: number, end: number, cls: string): void {
  let index = c.hlNames.indexOf(cls);
  if (index < 0) {
    c.hlNames.push(cls);
    index = c.hlNames.length - 1;
  }
  const e = Math.min(end, c.hlIndex.length);
  for (let i = Math.max(0, start); i < e; i++) c.hlIndex[i] = index + 1;
}

function lineIndexAt(c: Ctx, offset: number): number {
  let lo = 0;
  let hi = c.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function flagLines(c: Ctx, start: number, end: number, flag: number): void {
  const first = lineIndexAt(c, start);
  const last = lineIndexAt(c, Math.max(start, end - 1));
  for (let l = first; l <= last; l++) c.lineFlags[l] = (c.lineFlags[l] ?? 0) | flag;
}

/** A virtual text (a quote's inner lines, joined) with the source offset of each of its characters; `null` map = the text is the source. */
type Offsets = readonly number[] | null;

function srcAt(map: Offsets, i: number): number {
  return map ? map[i]! : i;
}

/** Paint a virtual range, split wherever the virtual text jumps over stripped prefixes. */
function paintVirtual(c: Ctx, map: Offsets, vs: number, ve: number, marks: number): void {
  if (ve <= vs) return;
  if (!map) return paint(c, vs, ve, marks);
  let runStart = vs;
  for (let i = vs; i < ve; i++) {
    const last = i === ve - 1;
    if (last || map[i + 1] !== map[i]! + 1) {
      paint(c, map[runStart]!, map[i]! + 1, marks);
      runStart = i + 1;
    }
  }
}

function paintHlVirtual(c: Ctx, map: Offsets, vs: number, ve: number, cls: string): void {
  if (ve <= vs) return;
  if (!map) return paintHl(c, vs, ve, cls);
  let runStart = vs;
  for (let i = vs; i < ve; i++) {
    const last = i === ve - 1;
    if (last || map[i + 1] !== map[i]! + 1) {
      paintHl(c, map[runStart]!, map[i]! + 1, cls);
      runStart = i + 1;
    }
  }
}

function flagVirtual(c: Ctx, map: Offsets, vs: number, ve: number, flag: number): void {
  if (ve <= vs) return;
  flagLines(c, srcAt(map, vs), srcAt(map, ve - 1) + 1, flag);
}

// ---------------------------------------------------------------------------------------------
// inline
// ---------------------------------------------------------------------------------------------

interface Delim {
  ch: string;
  /** Local offset of the first character of the run. */
  start: number;
  n: number;
  origN: number;
  canOpen: boolean;
  canClose: boolean;
  done: boolean;
}

const MARK_OF: Record<string, number> = { '*': Mark.Bold, _: Mark.Underline, '~': Mark.Strike, '|': Mark.Spoiler };

/** Style the inline syntax of `text[vs, ve)`. */
function inline(c: Ctx, text: string, map: Offsets, vs: number, ve: number): void {
  const s = text.slice(vs, ve);
  const len = s.length;
  const base = vs;
  const mark = (a: number, b: number, marks: number) => paintVirtual(c, map, base + a, base + b, marks);

  const delims: Delim[] = [];
  const brackets: { pos: number; delimIdx: number }[] = [];

  const processEmphasis = (from: number) => {
    for (let ci = from; ci < delims.length; ci++) {
      const closer = delims[ci]!;
      while (!closer.done && closer.canClose && closer.n > 0) {
        const emph = closer.ch === '*' || closer.ch === '_';
        let found = -1;
        for (let oi = ci - 1; oi >= from; oi--) {
          const o = delims[oi]!;
          if (o.done || o.n === 0 || o.ch !== closer.ch || !o.canOpen) continue;
          const bad = emph && (closer.canOpen || o.canClose) && (o.origN + closer.origN) % 3 === 0 && !(o.origN % 3 === 0 && closer.origN % 3 === 0);
          if (bad) continue;
          if (!emph && (o.n < 2 || closer.n < 2)) continue;
          found = oi;
          break;
        }
        if (found < 0) {
          if (!closer.canOpen) closer.done = true;
          break;
        }
        const o = delims[found]!;
        const use = emph ? (o.n >= 2 && closer.n >= 2 ? 2 : 1) : 2;
        const contentStart = o.start + o.n;
        const closePos = closer.start + (closer.origN - closer.n);
        mark(contentStart - use, contentStart, Mark.Syntax);
        mark(closePos, closePos + use, Mark.Syntax);
        const style = closer.ch === '*' ? (use === 2 ? Mark.Bold : Mark.Italic) : closer.ch === '_' ? (use === 2 ? Mark.Underline : Mark.Italic) : MARK_OF[closer.ch]!;
        mark(contentStart, closePos, style);
        for (let k = found + 1; k < ci; k++) delims[k]!.done = true;
        o.n -= use;
        closer.n -= use;
        const min = emph ? 1 : 2;
        if (o.n < min) o.done = true;
        if (closer.n < min) closer.done = true;
      }
    }
    for (let k = from; k < delims.length; k++) delims[k]!.done = true;
  };

  // backtick runs by length, for code spans
  let runsByLen: Map<number, number[]> | null = null;
  const runPtr = new Map<number, number>();
  const buildRuns = () => {
    const m = new Map<number, number[]>();
    let k = 0;
    while (k < len) {
      if (s.charCodeAt(k) === 96) {
        let e = k + 1;
        while (e < len && s.charCodeAt(e) === 96) e++;
        const arr = m.get(e - k);
        if (arr) arr.push(k);
        else m.set(e - k, [k]);
        k = e;
      } else k++;
    }
    return m;
  };

  const atomAt = (i: number, length: number, atom: Atom) => {
    const a = srcAt(map, base + i);
    c.atoms.set(a, { end: srcAt(map, base + i + length - 1) + 1, atom });
  };

  const emojiPattern = getEmojiRe();
  const tryEmoji = (i: number): number => {
    if (!emojiPattern) return 0;
    emojiPattern.lastIndex = i;
    const m = emojiPattern.exec(s);
    if (!m || m.index !== i || m[0].length === 0) return 0;
    mark(i, i + m[0].length, Mark.Emoji);
    return m[0].length;
  };
  const sticky = (re: RegExp, i: number): RegExpExecArray | null => {
    re.lastIndex = i;
    return re.exec(s);
  };

  let i = 0;
  while (i < len) {
    const ch = s.charCodeAt(i);
    switch (ch) {
      case 92: {
        const nx = s[i + 1];
        if (nx !== undefined && nx.charCodeAt(0) < 128 && ASCII_PUNCT_RE.test(nx)) {
          mark(i, i + 1, Mark.Syntax);
          i += 2;
        } else i++;
        break;
      }
      case 96: {
        let e = i + 1;
        while (e < len && s.charCodeAt(e) === 96) e++;
        const n = e - i;
        if (!runsByLen) runsByLen = buildRuns();
        const arr = runsByLen.get(n);
        let closeAt = -1;
        if (arr) {
          let p = runPtr.get(n) ?? 0;
          while (p < arr.length && arr[p]! < e) p++;
          runPtr.set(n, p);
          if (p < arr.length) closeAt = arr[p]!;
        }
        if (closeAt >= 0) {
          mark(i, e, Mark.Syntax | Mark.Code);
          mark(e, closeAt, Mark.Code);
          mark(closeAt, closeAt + n, Mark.Syntax | Mark.Code);
          i = closeAt + n;
        } else i = e;
        break;
      }
      case 42:
      case 95:
      case 126:
      case 124: {
        if (ch === 42 && s.charCodeAt(i + 1) === 0xfe0f && s.charCodeAt(i + 2) === 0x20e3) {
          const l = tryEmoji(i);
          if (l) {
            i += l;
            break;
          }
        }
        let e = i + 1;
        while (e < len && s.charCodeAt(e) === ch) e++;
        const n = e - i;
        const d = String.fromCharCode(ch);
        if ((ch === 126 || ch === 124) && n < 2) {
          i = e;
          break;
        }
        const prev = codePointBefore(s, i);
        const next = codePointAt(s, e);
        let canOpen: boolean;
        let canClose: boolean;
        if (ch === 126 || ch === 124) {
          canOpen = true;
          canClose = true;
        } else {
          const prevWs = isWs(prev);
          const nextWs = isWs(next);
          const prevP = isPunct(prev);
          const nextP = isPunct(next);
          const left = !nextWs && (!nextP || prevWs || prevP);
          const right = !prevWs && (!prevP || nextWs || nextP);
          if (ch === 42) {
            canOpen = left;
            canClose = right;
          } else {
            canOpen = left && (!right || prevP);
            canClose = right && (!left || nextP);
          }
        }
        if (canOpen || canClose) delims.push({ ch: d, start: i, n, origN: n, canOpen, canClose, done: false });
        i = e;
        break;
      }
      case 91:
        brackets.push({ pos: i, delimIdx: delims.length });
        i++;
        break;
      case 93: {
        const br = brackets.pop();
        if (br && s.charCodeAt(i + 1) === 40 && br.pos + 1 < i) {
          const dest = parseLinkDest(s, i + 1);
          if (dest && SAFE_HREF_RE.test(s.slice(dest.urlStart, dest.urlEnd))) {
            processEmphasis(br.delimIdx);
            mark(br.pos, br.pos + 1, Mark.Syntax);
            mark(i, dest.urlStart, Mark.Syntax);
            mark(dest.urlStart, dest.urlEnd, Mark.Link);
            mark(dest.urlEnd, dest.end, Mark.Syntax);
            i = dest.end;
            break;
          }
        }
        i++;
        break;
      }
      case 60: {
        let m: RegExpExecArray | null;
        let atom: Atom | null = null;
        if ((m = sticky(USER_RE, i))) atom = { kind: 'user', id: m[1]! };
        else if ((m = sticky(ROLE_RE, i))) atom = { kind: 'role', id: m[1]! };
        else if ((m = sticky(CHANNEL_RE, i))) atom = { kind: 'channel', id: m[1]! };
        else if ((m = sticky(TIMESTAMP_RE, i))) atom = { kind: 'timestamp', unix: Number(m[1]), style: (m[2] as TimestampStyle | undefined) ?? 'f' };
        else if ((m = sticky(CUSTOM_EMOJI_RE, i))) atom = { kind: 'emoji', name: m[2]!, id: m[3]!, animated: m[1] === 'a' };
        if (atom && m) {
          atomAt(i, m[0].length, atom);
          i += m[0].length;
          break;
        }
        if ((m = sticky(ANGLE_URL_RE, i))) {
          mark(i, i + 1, Mark.Syntax);
          mark(i + 1, i + m[0].length - 1, Mark.Link);
          mark(i + m[0].length - 1, i + m[0].length, Mark.Syntax);
          i += m[0].length;
          break;
        }
        i++;
        break;
      }
      case 64:
      case 35: {
        // @everyone / @here, then mentions picked from the autocomplete
        const before = i > 0 ? s[i - 1]! : '';
        if (ch === 64) {
          const word = s.startsWith('everyone', i + 1) ? 'everyone' : s.startsWith('here', i + 1) ? 'here' : null;
          if (word) {
            const after = s[i + 1 + word.length];
            if ((after === undefined || !/[A-Za-z0-9_]/.test(after)) && !(before !== '' && ALNUM_RE.test(before))) {
              mark(i, i + 1 + word.length, Mark.Mention);
              i += 1 + word.length;
              break;
            }
          }
        }
        if (c.mentions.length > 0 && (before === '' || WS_RE.test(before))) {
          const hit = c.mentions.find(t => s.startsWith(t, i) && !/[\p{L}\p{N}_]/u.test(s[i + t.length] ?? ''));
          if (hit) {
            mark(i, i + hit.length, Mark.Mention);
            i += hit.length;
            break;
          }
        }
        i++;
        break;
      }
      case 58: {
        const shortcodes = c.opts.shortcodes;
        if (shortcodes && shortcodes.size > 0) {
          const m = sticky(SHORTCODE_RE, i);
          if (m) {
            const name = m[1]!;
            const unicode = shortcodes.get(name) ?? shortcodes.get(name.toLowerCase());
            if (unicode !== undefined) {
              atomAt(i, m[0].length, { kind: 'shortcode', name, unicode });
              i += m[0].length;
              break;
            }
          }
        }
        i++;
        break;
      }
      case 104:
      case 72: {
        const before = i > 0 ? s[i - 1]! : '';
        if (!(before !== '' && ALNUM_RE.test(before))) {
          const head8 = s.slice(i, i + 8).toLowerCase();
          const schemeLen = head8.startsWith('https://') ? 8 : head8.startsWith('http://') ? 7 : 0;
          if (schemeLen > 0) {
            let e = i + schemeLen;
            let sqDepth = 0;
            while (e < len) {
              const cc = s.charCodeAt(e);
              if (cc === 60 || WS_RE.test(s[e]!)) break;
              if (cc === 91) sqDepth++;
              else if (cc === 93) {
                if (sqDepth === 0 && brackets.length > 0) break;
                sqDepth--;
              }
              e++;
            }
            let opens = 0;
            let closes = 0;
            let sq = 0;
            let sqc = 0;
            for (let k = i + schemeLen; k < e; k++) {
              const cc = s.charCodeAt(k);
              if (cc === 40) opens++;
              else if (cc === 41) closes++;
              else if (cc === 91) sq++;
              else if (cc === 93) sqc++;
            }
            while (e > i + schemeLen) {
              const last = s[e - 1]!;
              if (URL_TRAIL.includes(last)) e--;
              else if (last === ')' && closes > opens) {
                closes--;
                e--;
              } else if (last === ']' && sqc > sq) {
                sqc--;
                e--;
              } else break;
            }
            if (e > i + schemeLen) {
              mark(i, e, Mark.Link);
              i = e;
              break;
            }
          }
        }
        i++;
        break;
      }
      default: {
        if (ch >= 0x203c || ((ch === 35 || ch === 0xa9 || ch === 0xae || (ch >= 48 && ch <= 57)) && isKeycapTail(s, i + 1))) {
          const l = tryEmoji(i);
          if (l) {
            i += l;
            break;
          }
        }
        i++;
      }
    }
  }
  processEmphasis(0);
}

// ---------------------------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------------------------

/** Walk the block structure of `text` (source, or a quote's stripped inner text with its offsets). */
function blocks(c: Ctx, text: string, map: Offsets, inQuote: boolean): void {
  const n = text.length;
  let pos = 0;
  let paraStart = -1;
  let paraEnd = -1;
  let fenceDead = false;

  const flushPara = () => {
    if (paraStart >= 0) inline(c, text, map, paraStart, paraEnd);
    paraStart = -1;
    paraEnd = -1;
  };

  /** Build the stripped inner text of quote lines: pieces are [virtual start, virtual end) ranges of `text`. */
  const recurseQuote = (pieces: { from: number; to: number }[]) => {
    let inner = '';
    const offsets: number[] = [];
    for (let k = 0; k < pieces.length; k++) {
      const piece = pieces[k]!;
      if (k > 0) {
        inner += '\n';
        offsets.push(srcAt(map, pieces[k - 1]!.to));
      }
      inner += text.slice(piece.from, piece.to);
      for (let j = piece.from; j < piece.to; j++) offsets.push(srcAt(map, j));
    }
    const last = pieces[pieces.length - 1]!;
    offsets.push(last.to > last.from ? srcAt(map, last.to - 1) + 1 : srcAt(map, last.to));
    blocks(c, inner, offsets, true);
  };

  while (pos < n) {
    let eol = text.indexOf('\n', pos);
    if (eol < 0) eol = n;
    const line = text.slice(pos, eol);

    if (line.startsWith('```') && !fenceDead) {
      const open = pos + 3;
      const close = text.indexOf('```', open);
      if (close < 0) fenceDead = true;
      else {
        let body = text.slice(open, close);
        let lang: string | null = null;
        const m = FENCE_LANG_RE.exec(body);
        let bodyOffset = 0;
        if (m) {
          lang = m[1]!;
          bodyOffset = m[0].length;
          body = body.slice(bodyOffset);
        }
        let a = 0;
        let b = body.length;
        while (a < b && body.charCodeAt(a) === 10) a++;
        while (b > a && body.charCodeAt(b - 1) === 10) b--;
        const code = body.slice(a, b);
        if (code.length > 0) {
          flushPara();
          paintVirtual(c, map, pos, open, Mark.Syntax);
          if (lang) paintVirtual(c, map, open, open + lang.length, Mark.Syntax);
          paintVirtual(c, map, open + bodyOffset, close, Mark.Code);
          paintVirtual(c, map, close, close + 3, Mark.Syntax);
          flagVirtual(c, map, pos, close + 3, LineFlag.Code);
          if (c.opts.highlight) {
            const codeStart = open + bodyOffset + a;
            for (const r of c.opts.highlight(code, lang)) paintHlVirtual(c, map, codeStart + r.start, codeStart + r.end, r.cls);
          }
          pos = close + 3;
          if (text.charCodeAt(pos) === 10) pos++;
          continue;
        }
      }
    }

    if (!inQuote && line.startsWith('>>> ')) {
      flushPara();
      paintVirtual(c, map, pos, pos + 4, Mark.Syntax | Mark.QuoteMark);
      flagVirtual(c, map, pos, n, LineFlag.Quote);
      // the rest of the lines carry no prefix: they are drawn as the body of the quote
      if (eol < n) flagVirtual(c, map, eol + 1, n, LineFlag.QuoteBody);
      recurseQuote([{ from: pos + 4, to: n }]);
      pos = n;
      break;
    }

    if (!inQuote && line.startsWith('> ')) {
      flushPara();
      const pieces: { from: number; to: number }[] = [];
      let p = pos;
      while (p < n) {
        let e = text.indexOf('\n', p);
        if (e < 0) e = n;
        const l = text.slice(p, e);
        if (l.startsWith('> ')) {
          paintVirtual(c, map, p, p + 2, Mark.Syntax | Mark.QuoteMark);
          pieces.push({ from: p + 2, to: e });
        } else if (l === '>') {
          paintVirtual(c, map, p, p + 1, Mark.Syntax | Mark.QuoteMark);
          pieces.push({ from: p + 1, to: e });
        } else break;
        flagVirtual(c, map, p, e, LineFlag.Quote);
        p = e + 1;
      }
      recurseQuote(pieces);
      pos = p;
      continue;
    }

    let m = HEADING_RE.exec(line);
    if (m) {
      flushPara();
      const hashes = m[1]!.length;
      const spaces = /^ */.exec(line.slice(hashes))![0].length;
      paintVirtual(c, map, pos, pos + hashes + spaces, Mark.Syntax);
      flagVirtual(c, map, pos, eol, LineFlag.Heading);
      inline(c, text, map, pos + hashes + spaces, eol);
      pos = eol + 1;
      continue;
    }

    m = SUBTEXT_RE.exec(line);
    if (m) {
      flushPara();
      const spaces = /^ */.exec(line.slice(2))![0].length;
      paintVirtual(c, map, pos, pos + 2 + spaces, Mark.Syntax);
      flagVirtual(c, map, pos, eol, LineFlag.Subtext);
      inline(c, text, map, pos + 2 + spaces, eol);
      pos = eol + 1;
      continue;
    }

    const ul = UL_RE.exec(line);
    const ol = ul ? null : OL_RE.exec(line);
    if (ul || ol) {
      flushPara();
      const ordered = ol !== null;
      let p = pos;
      while (p < n) {
        let e = text.indexOf('\n', p);
        if (e < 0) e = n;
        const l = text.slice(p, e);
        const mm = ordered ? OL_RE.exec(l) : UL_RE.exec(l);
        if (!mm || (!ordered && SUBTEXT_RE.test(l))) break;
        const indent = /^ */.exec(l)![0].length;
        const marker = ordered ? `${mm[1]}.` : l[indent]!;
        const afterMarker = indent + marker.length;
        const spaces = /^ */.exec(l.slice(afterMarker))![0].length;
        // Discord dims the bullet but leaves an ordered list's number at body colour
        if (!ordered) paintVirtual(c, map, p + indent, p + afterMarker, Mark.Syntax);
        flagVirtual(c, map, p, e, LineFlag.List);
        inline(c, text, map, p + afterMarker + spaces, e);
        p = e + 1;
      }
      pos = p;
      continue;
    }

    if (paraStart < 0) paraStart = pos;
    paraEnd = eol;
    pos = eol + 1;
  }
  flushPara();
}

// ---------------------------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------------------------

/** One unstyled line per source line (preview off, or an over-long draft). */
export function plainLines(source: string): EditorLine[] {
  const lines: EditorLine[] = [];
  let start = 0;
  for (;;) {
    const nl = source.indexOf('\n', start);
    const end = nl < 0 ? source.length : nl;
    lines.push({ start, end, flags: 0, segments: end > start ? [{ start, end, marks: 0, hl: null, atom: null }] : [] });
    if (nl < 0) break;
    start = nl + 1;
  }
  return lines;
}

/** Style `source`. The result always has at least one line; segments never cross a line and never contain "\n". */
export function tokenize(source: string, opts: TokenizeOptions = {}): EditorLine[] {
  const src = source.replace(/\r\n?/g, '\n');
  if (src.length === 0 || src.length > MAX_STYLED_LENGTH) return plainLines(src);
  const lineStarts = [0];
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const c: Ctx = {
    source: src,
    opts,
    marks: new Uint16Array(src.length),
    hlIndex: new Uint16Array(src.length),
    hlNames: [],
    atoms: new Map(),
    lineStarts,
    lineFlags: lineStarts.map(() => 0),
    mentions: [...(opts.mentions ?? [])].sort((a, b) => b.length - a.length),
  };
  try {
    blocks(c, src, null, false);
  } catch {
    return plainLines(src);
  }

  const lines: EditorLine[] = [];
  for (let l = 0; l < lineStarts.length; l++) {
    const start = lineStarts[l]!;
    const end = l + 1 < lineStarts.length ? lineStarts[l + 1]! - 1 : src.length;
    const segments: Segment[] = [];
    let i = start;
    while (i < end) {
      const chip = c.atoms.get(i);
      if (chip && chip.end <= end) {
        segments.push({ start: i, end: chip.end, marks: c.marks[i] ?? 0, hl: null, atom: chip.atom });
        i = chip.end;
        continue;
      }
      const marks = c.marks[i] ?? 0;
      const hl = c.hlIndex[i] ?? 0;
      let j = i + 1;
      while (j < end && (c.marks[j] ?? 0) === marks && (c.hlIndex[j] ?? 0) === hl && !c.atoms.has(j)) j++;
      segments.push({ start: i, end: j, marks, hl: hl > 0 ? c.hlNames[hl - 1]! : null, atom: null });
      i = j;
    }
    lines.push({ start, end, flags: c.lineFlags[l] ?? 0, segments });
  }
  return lines;
}

/** Atom ranges of tokenized lines, for the edit helpers. */
export function atomRanges(lines: readonly EditorLine[]): [number, number][] {
  const out: [number, number][] = [];
  for (const line of lines) for (const seg of line.segments) if (seg.atom) out.push([seg.start, seg.end]);
  return out;
}
