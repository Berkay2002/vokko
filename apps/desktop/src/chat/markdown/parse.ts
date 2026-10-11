import type { Block, Inline, ParseOptions } from './ast';

/*
 * Discord-flavoured markdown parser.
 *
 * Block level: a single pass over the source (fences, quotes, headings, lists, paragraphs).
 * Inline level: a tokenizer feeding a CommonMark-style delimiter stack (with the "openers bottom"
 * optimisation, so emphasis resolution is linear) and a bracket stack for masked links.
 * Nothing in here is recursive in the input size, and nothing throws: parseMarkdown falls back to a
 * single plain-text paragraph if something unexpected happens.
 */

// ---------------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------------

export function parseMarkdown(src: string, opts?: ParseOptions): Block[] {
  try {
    const text = src.replace(/\r\n?/g, '\n');
    const parser = new BlockParser(text, opts?.emojiShortcodes);
    return parser.parse(false);
  } catch {
    return src.length > 0 ? [{ t: 'paragraph', c: [{ t: 'text', v: src }] }] : [];
  }
}

/** Whole message is only emoji / custom emoji (1..27) separated by optional whitespace. */
export function isJumbo(blocks: Block[]): boolean {
  if (blocks.length !== 1) return false;
  const b = blocks[0]!;
  if (b.t !== 'paragraph') return false;
  let count = 0;
  for (const n of b.c) {
    if (n.t === 'emoji' || n.t === 'customEmoji') {
      count++;
      if (count > 27) return false;
    } else if (n.t === 'br') {
      // newlines count as whitespace
    } else if (n.t === 'text') {
      if (n.v.trim() !== '') return false;
    } else {
      return false;
    }
  }
  return count >= 1;
}

// ---------------------------------------------------------------------------------------------
// block parser
// ---------------------------------------------------------------------------------------------

const HEADING_RE = /^(#{1,3}) +(\S.*)$/;
const SUBTEXT_RE = /^-# +(\S.*)$/;
const UL_RE = /^ *[-*] +(\S.*)$/;
const OL_RE = /^ *(\d{1,9})\. +(\S.*)$/;
const FENCE_LANG_RE = /^([A-Za-z0-9_+\-.#]+)\n/;

class BlockParser {
  constructor(
    private readonly src: string,
    private readonly shortcodes: ReadonlyMap<string, string> | undefined,
  ) {}

  parse(inQuote: boolean): Block[] {
    return this.parseRange(this.src, inQuote);
  }

  /** Parse `text` (a whole message, or the stripped inside of a quote). */
  private parseRange(text: string, inQuote: boolean): Block[] {
    const blocks: Block[] = [];
    const n = text.length;
    let pos = 0;
    let para: string[] = [];
    // each parseRange gets its own fence-failure memo (the text differs between quote levels)
    let fenceDead = false;

    const flushPara = () => {
      let a = 0;
      let b = para.length;
      while (a < b && para[a]!.trim() === '') a++;
      while (b > a && para[b - 1]!.trim() === '') b--;
      if (a < b) {
        blocks.push({ t: 'paragraph', c: parseInline(para.slice(a, b).join('\n'), this.shortcodes) });
      }
      para = [];
    };

    const tryFence = (at: number): { block: Block; end: number } | null => {
      if (fenceDead) return null;
      const open = at + 3;
      const close = text.indexOf('```', open);
      if (close < 0) {
        fenceDead = true;
        return null;
      }
      let body = text.slice(open, close);
      let lang: string | null = null;
      const m = FENCE_LANG_RE.exec(body);
      if (m) {
        lang = m[1]!;
        body = body.slice(m[0].length);
      }
      let a = 0;
      let b = body.length;
      while (a < b && body.charCodeAt(a) === 10) a++;
      while (b > a && body.charCodeAt(b - 1) === 10) b--;
      body = body.slice(a, b);
      if (body.length === 0) return null;
      return { block: { t: 'codeblock', lang, v: body }, end: close + 3 };
    };

    while (pos < n) {
      let eol = text.indexOf('\n', pos);
      if (eol < 0) eol = n;
      const line = text.slice(pos, eol);

      if (line.startsWith('```')) {
        const cb = tryFence(pos);
        if (cb) {
          flushPara();
          blocks.push(cb.block);
          pos = cb.end;
          if (text.charCodeAt(pos) === 10) pos++;
          continue;
        }
      }

      if (!inQuote && line.startsWith('>>> ')) {
        flushPara();
        const inner = text.slice(pos + 4);
        blocks.push({ t: 'quote', c: this.parseRange(inner, true) });
        pos = n;
        break;
      }

      if (!inQuote && line.startsWith('> ')) {
        flushPara();
        const inner: string[] = [];
        let p = pos;
        while (p < n) {
          let e = text.indexOf('\n', p);
          if (e < 0) e = n;
          const l = text.slice(p, e);
          if (l.startsWith('> ')) inner.push(l.slice(2));
          else if (l === '>') inner.push('');
          else break;
          p = e + 1;
        }
        blocks.push({ t: 'quote', c: this.parseRange(inner.join('\n'), true) });
        pos = p;
        continue;
      }

      let m = HEADING_RE.exec(line);
      if (m) {
        flushPara();
        blocks.push({
          t: 'heading',
          level: m[1]!.length as 1 | 2 | 3,
          c: parseInline(m[2]!.trimEnd(), this.shortcodes),
        });
        pos = eol + 1;
        continue;
      }

      m = SUBTEXT_RE.exec(line);
      if (m) {
        flushPara();
        blocks.push({ t: 'subtext', c: parseInline(m[1]!.trimEnd(), this.shortcodes) });
        pos = eol + 1;
        continue;
      }

      const ul = UL_RE.exec(line);
      const ol = ul ? null : OL_RE.exec(line);
      if (ul || ol) {
        flushPara();
        const ordered = ol !== null;
        const start = ol ? Number(ol[1]) : 1;
        const items: Inline[][] = [];
        let p = pos;
        while (p < n) {
          let e = text.indexOf('\n', p);
          if (e < 0) e = n;
          const l = text.slice(p, e);
          const mm = ordered ? OL_RE.exec(l) : UL_RE.exec(l);
          if (!mm) break;
          // "-# subtext" must not be swallowed by an unordered list
          if (!ordered && SUBTEXT_RE.test(l)) break;
          items.push(parseInline((ordered ? mm[2]! : mm[1]!).trimEnd(), this.shortcodes));
          p = e + 1;
        }
        blocks.push({ t: 'list', ordered, start, items });
        pos = p;
        continue;
      }

      para.push(line);
      pos = eol + 1;
    }
    flushPara();
    return blocks;
  }
}

// ---------------------------------------------------------------------------------------------
// inline parser
// ---------------------------------------------------------------------------------------------

const MAX_DEPTH = 20;
const MAX_URL = 2048;

interface Item {
  prev: Item | null;
  next: Item | null;
  /** finished node (null for sentinels and for live delimiter runs) */
  node: Inline | null;
  d: Delim | null;
  depth: number;
}

interface Delim {
  ch: string;
  n: number;
  origN: number;
  canOpen: boolean;
  canClose: boolean;
  item: Item;
  idx: number;
  prev: Delim | null;
  next: Delim | null;
}

interface Bracket {
  item: Item;
  delimBottom: Delim;
}

const CH_INDEX: Record<string, number> = { '*': 0, _: 1, '~': 2, '|': 3 };

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
      // built at runtime: the `v` flag is rejected by the TS target
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

function newItem(node: Inline | null, d: Delim | null, depth: number): Item {
  return { prev: null, next: null, node, d, depth };
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
const isPunct = (c: string) =>
  c !== '' && (c.length === 1 && c.charCodeAt(0) < 128 ? ASCII_PUNCT_RE.test(c) : UNI_PUNCT_RE.test(c));

function pushInline(arr: Inline[], node: Inline): void {
  if (node.t === 'text') {
    if (node.v === '') return;
    const last = arr[arr.length - 1];
    if (last && last.t === 'text') {
      arr[arr.length - 1] = { t: 'text', v: last.v + node.v };
      return;
    }
  }
  arr.push(node);
}

/** `(url)` / `(<url>)` / `(url "title")` starting at s[k] === '('. */
function parseLinkDest(s: string, k: number): { url: string; end: number } | null {
  const len = s.length;
  let p = k + 1;
  while (p < len && (s[p] === ' ' || s[p] === '\t')) p++;
  let url: string;
  if (s[p] === '<') {
    const start = p + 1;
    let q = start;
    while (q < len && q - start < MAX_URL) {
      const c = s[q]!;
      if (c === '>' || c === '<' || c === '\n' || c === ' ' || c === '\t') break;
      q++;
    }
    if (s[q] !== '>') return null;
    url = s.slice(start, q);
    p = q + 1;
  } else {
    const start = p;
    let depth = 0;
    while (p < len && p - start < MAX_URL) {
      const c = s[p]!;
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      p++;
    }
    url = s.slice(start, p);
  }
  if (url === '') return null;
  while (p < len && (s[p] === ' ' || s[p] === '\t')) p++;
  if (s[p] === '"') {
    let q = p + 1;
    while (q < len && q - p < 512 && s[q] !== '"' && s[q] !== '\n') q++;
    if (s[q] !== '"') return null;
    p = q + 1;
    while (p < len && (s[p] === ' ' || s[p] === '\t')) p++;
  }
  if (s[p] !== ')') return null;
  return { url, end: p + 1 };
}

function parseInline(s: string, shortcodes: ReadonlyMap<string, string> | undefined): Inline[] {
  const len = s.length;
  // linked list of items between two sentinels
  const head = newItem(null, null, 0);
  const tail = newItem(null, null, 0);
  head.next = tail;
  tail.prev = head;

  const append = (node: Inline, depth = 0): Item => {
    const it = newItem(node, null, depth);
    const p = tail.prev!;
    p.next = it;
    it.prev = p;
    it.next = tail;
    tail.prev = it;
    return it;
  };
  const removeItem = (it: Item) => {
    it.prev!.next = it.next;
    it.next!.prev = it.prev;
  };
  const insertAfter = (after: Item, it: Item) => {
    const nx = after.next!;
    after.next = it;
    it.prev = after;
    it.next = nx;
    nx.prev = it;
  };

  // delimiter stack (doubly linked, `root` is the base)
  const root: Delim = {
    ch: '',
    n: 0,
    origN: 0,
    canOpen: false,
    canClose: false,
    item: head,
    idx: -1,
    prev: null,
    next: null,
  };
  let top: Delim = root;
  let delimCounter = 0;
  const brackets: Bracket[] = [];

  const removeDelim = (d: Delim) => {
    d.prev!.next = d.next;
    if (d.next) d.next.prev = d.prev;
    else top = d.prev!;
  };
  /** The delimiter leaves the stack and becomes literal text (or disappears when exhausted). */
  const dropDelim = (d: Delim) => {
    removeDelim(d);
    d.item.d = null;
    if (d.n > 0) d.item.node = { t: 'text', v: d.ch.repeat(d.n) };
    else removeItem(d.item);
  };

  /** Detach everything strictly between `from` and `to`; delimiters become literal text. */
  const collect = (from: Item, to: Item): { items: Item[]; maxDepth: number } => {
    const items: Item[] = [];
    let maxDepth = 0;
    let it = from.next;
    while (it && it !== to) {
      const nx = it.next;
      if (it.d) {
        it.node = { t: 'text', v: it.d.ch.repeat(it.d.n) };
        it.d = null;
      }
      if (it.depth > maxDepth) maxDepth = it.depth;
      items.push(it);
      it = nx;
    }
    from.next = to;
    to.prev = from;
    return { items, maxDepth };
  };

  const toInlines = (items: Item[], unlink: boolean): Inline[] => {
    const out: Inline[] = [];
    for (const it of items) {
      const node = it.node;
      if (!node) continue;
      if (unlink && node.t === 'link') {
        for (const c of node.c) pushInline(out, c);
      } else {
        pushInline(out, node);
      }
    }
    return out;
  };

  const processEmphasis = (bottom: Delim) => {
    const openersBottom = new Map<number, number>();
    let closer: Delim | null = bottom.next;
    while (closer) {
      if (!closer.canClose) {
        closer = closer.next;
        continue;
      }
      const emph = closer.ch === '*' || closer.ch === '_';
      const key = CH_INDEX[closer.ch]! * 6 + (closer.canOpen ? 3 : 0) + (closer.n % 3);
      const low = openersBottom.get(key) ?? bottom.idx;
      let opener: Delim | null = closer.prev;
      let found: Delim | null = null;
      while (opener && opener.idx > low) {
        if (opener.ch === closer.ch && opener.canOpen && opener.item.next !== closer.item) {
          const bad =
            emph &&
            (closer.canOpen || opener.canClose) &&
            (opener.origN + closer.origN) % 3 === 0 &&
            !(opener.origN % 3 === 0 && closer.origN % 3 === 0);
          if (!bad) {
            found = opener;
            break;
          }
        }
        opener = opener.prev;
      }

      if (!found) {
        openersBottom.set(key, closer.prev ? closer.prev.idx : bottom.idx);
        const nx: Delim | null = closer.next;
        if (!closer.canOpen) dropDelim(closer);
        closer = nx;
        continue;
      }

      const ch = closer.ch;
      const min = emph ? 1 : 2;
      const use = emph ? (found.n >= 2 && closer.n >= 2 ? 2 : 1) : 2;
      const { items, maxDepth } = collect(found.item, closer.item);
      // delimiters between opener and closer are gone (their items are literal text now)
      found.next = closer;
      closer.prev = found;
      found.n -= use;
      closer.n -= use;

      if (maxDepth + 1 > MAX_DEPTH) {
        // absurdly deep nesting: keep the content, drop the formatting
        let after = found.item;
        for (const it of items) {
          insertAfter(after, it);
          after = it;
        }
      } else {
        let type: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler';
        if (ch === '*') type = use === 2 ? 'bold' : 'italic';
        else if (ch === '_') type = use === 2 ? 'underline' : 'italic';
        else if (ch === '~') type = 'strike';
        else type = 'spoiler';
        const nodeItem = newItem({ t: type, c: toInlines(items, false) }, null, maxDepth + 1);
        insertAfter(found.item, nodeItem);
      }

      if (found.n < min) dropDelim(found);
      if (closer.n < min) {
        const nx: Delim | null = closer.next;
        dropDelim(closer);
        closer = nx;
      }
      // else: same closer again (it may match an earlier opener)
    }
    // remaining delimiters above `bottom` are literal
    let d = bottom.next;
    while (d) {
      const nx: Delim | null = d.next;
      d.item.d = null;
      d.item.node = { t: 'text', v: d.ch.repeat(d.n) };
      d = nx;
    }
    bottom.next = null;
    top = bottom;
  };

  // backtick runs index (built lazily, once)
  let runsByLen: Map<number, number[]> | null = null;
  const runPtr = new Map<number, number>();
  const buildRuns = () => {
    const m = new Map<number, number[]>();
    let k = 0;
    while (k < len) {
      if (s.charCodeAt(k) === 96) {
        let e = k + 1;
        while (e < len && s.charCodeAt(e) === 96) e++;
        const l = e - k;
        const arr = m.get(l);
        if (arr) arr.push(k);
        else m.set(l, [k]);
        k = e;
      } else k++;
    }
    return m;
  };

  let buf = '';
  let textStart = 0;
  const flushText = (upto: number) => {
    if (upto > textStart) {
      buf += s.slice(textStart, upto);
      textStart = upto;
    }
    if (buf !== '') {
      append({ t: 'text', v: buf });
      buf = '';
    }
  };

  const emojiPattern = getEmojiRe();
  const tryEmoji = (i: number): number => {
    if (!emojiPattern) return 0;
    emojiPattern.lastIndex = i;
    const m = emojiPattern.exec(s);
    if (!m || m.index !== i || m[0].length === 0) return 0;
    flushText(i);
    append({ t: 'emoji', unicode: m[0] });
    return m[0].length;
  };

  /** Run a sticky regexp at i. */
  const sticky = (re: RegExp, i: number): RegExpExecArray | null => {
    re.lastIndex = i;
    return re.exec(s);
  };

  let i = 0;
  while (i < len) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 92: {
        // backslash
        const nx = s[i + 1];
        if (nx !== undefined && nx.charCodeAt(0) < 128 && ASCII_PUNCT_RE.test(nx)) {
          buf += s.slice(textStart, i) + nx;
          i += 2;
          textStart = i;
        } else {
          i++;
        }
        break;
      }
      case 96: {
        // backtick
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
          flushText(i);
          let content = s.slice(e, closeAt);
          if (
            content.length >= 2 &&
            content.charCodeAt(0) === 32 &&
            content.charCodeAt(content.length - 1) === 32 &&
            content.trim() !== ''
          ) {
            content = content.slice(1, -1);
          }
          append({ t: 'code', v: content });
          i = closeAt + n;
          textStart = i;
        } else {
          i = e; // the whole run is literal text
        }
        break;
      }
      case 42: // *
      case 95: // _
      case 126: // ~
      case 124: {
        // |
        if (c === 42 && s.charCodeAt(i + 1) === 0xfe0f && s.charCodeAt(i + 2) === 0x20e3) {
          const l = tryEmoji(i);
          if (l) {
            i += l;
            textStart = i;
            break;
          }
        }
        let e = i + 1;
        while (e < len && s.charCodeAt(e) === c) e++;
        const n = e - i;
        const ch = String.fromCharCode(c);
        if ((c === 126 || c === 124) && n < 2) {
          i = e;
          break;
        }
        const prev = codePointBefore(s, i);
        const next = codePointAt(s, e);
        let canOpen: boolean;
        let canClose: boolean;
        if (c === 126 || c === 124) {
          canOpen = true;
          canClose = true;
        } else {
          const prevWs = isWs(prev);
          const nextWs = isWs(next);
          const prevP = isPunct(prev);
          const nextP = isPunct(next);
          const left = !nextWs && (!nextP || prevWs || prevP);
          const right = !prevWs && (!prevP || nextWs || nextP);
          if (c === 42) {
            canOpen = left;
            canClose = right;
          } else {
            canOpen = left && (!right || prevP);
            canClose = right && (!left || nextP);
          }
        }
        if (!canOpen && !canClose) {
          i = e;
          break;
        }
        flushText(i);
        const item = append({ t: 'text', v: '' });
        item.node = null;
        const d: Delim = {
          ch,
          n,
          origN: n,
          canOpen,
          canClose,
          item,
          idx: delimCounter++,
          prev: top,
          next: null,
        };
        item.d = d;
        top.next = d;
        top = d;
        i = e;
        textStart = i;
        break;
      }
      case 91: {
        // [
        flushText(i);
        const item = append({ t: 'text', v: '[' });
        brackets.push({ item, delimBottom: top });
        i++;
        textStart = i;
        break;
      }
      case 93: {
        // ]
        const br = brackets.pop();
        if (br && s.charCodeAt(i + 1) === 40) {
          flushText(i);
          const dest = br.item.next !== tail ? parseLinkDest(s, i + 1) : null;
          if (dest && SAFE_HREF_RE.test(dest.url)) {
            processEmphasis(br.delimBottom);
            const { items, maxDepth } = collect(br.item, tail);
            const children = toInlines(items, true);
            removeItem(br.item);
            if (children.length > 0) {
              append({ t: 'link', href: dest.url, c: children, masked: true }, maxDepth + 1);
            }
            i = dest.end;
            textStart = i;
            break;
          }
        }
        i++;
        break;
      }
      case 60: {
        // <
        let m: RegExpExecArray | null;
        let node: Inline | null = null;
        if ((m = sticky(USER_RE, i))) node = { t: 'mention', kind: 'user', id: m[1]! };
        else if ((m = sticky(ROLE_RE, i))) node = { t: 'mention', kind: 'role', id: m[1]! };
        else if ((m = sticky(CHANNEL_RE, i))) node = { t: 'mention', kind: 'channel', id: m[1]! };
        else if ((m = sticky(TIMESTAMP_RE, i))) {
          node = {
            t: 'timestamp',
            unix: Number(m[1]),
            style: (m[2] as 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R' | undefined) ?? 'f',
          };
        } else if ((m = sticky(CUSTOM_EMOJI_RE, i))) {
          node = { t: 'customEmoji', name: m[2]!, id: m[3]!, animated: m[1] === 'a' };
        } else if ((m = sticky(ANGLE_URL_RE, i))) {
          const url = m[1]!;
          node = { t: 'link', href: url, c: [{ t: 'text', v: url }], masked: false };
        }
        if (node && m) {
          flushText(i);
          append(node, node.t === 'link' ? 1 : 0);
          i += m[0].length;
          textStart = i;
        } else {
          i++;
        }
        break;
      }
      case 64: {
        // @
        let word: 'everyone' | 'here' | null = null;
        if (s.startsWith('everyone', i + 1)) word = 'everyone';
        else if (s.startsWith('here', i + 1)) word = 'here';
        if (word) {
          const after = s[i + 1 + word.length];
          const before = i > 0 ? s[i - 1]! : '';
          if ((after === undefined || !/[A-Za-z0-9_]/.test(after)) && !(before !== '' && ALNUM_RE.test(before))) {
            flushText(i);
            append(word === 'everyone' ? { t: 'everyone' } : { t: 'here' });
            i += 1 + word.length;
            textStart = i;
            break;
          }
        }
        i++;
        break;
      }
      case 58: {
        // :
        if (shortcodes && shortcodes.size > 0) {
          const m = sticky(SHORTCODE_RE, i);
          if (m) {
            const name = m[1]!;
            const uni = shortcodes.get(name) ?? shortcodes.get(name.toLowerCase());
            if (uni !== undefined) {
              flushText(i);
              append({ t: 'emoji', unicode: uni, name });
              i += m[0].length;
              textStart = i;
              break;
            }
          }
        }
        i++;
        break;
      }
      case 104: // h
      case 72: {
        // H
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
                // inside link text, an unmatched `]` closes the text rather than belonging to the URL
                if (sqDepth === 0 && brackets.length > 0) break;
                sqDepth--;
              }
              e++;
            }
            // trim trailing punctuation (and unbalanced closing brackets)
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
              if (URL_TRAIL.includes(last)) {
                e--;
              } else if (last === ')' && closes > opens) {
                closes--;
                e--;
              } else if (last === ']' && sqc > sq) {
                sqc--;
                e--;
              } else break;
            }
            if (e > i + schemeLen) {
              flushText(i);
              const url = s.slice(i, e);
              append({ t: 'link', href: url, c: [{ t: 'text', v: url }], masked: false }, 1);
              i = e;
              textStart = i;
              break;
            }
          }
        }
        i++;
        break;
      }
      case 10: {
        flushText(i);
        append({ t: 'br' });
        i++;
        textStart = i;
        break;
      }
      default: {
        if (
          c >= 0x203c ||
          ((c === 35 || c === 0xa9 || c === 0xae || (c >= 48 && c <= 57)) && isKeycapTail(s, i + 1))
        ) {
          const l = tryEmoji(i);
          if (l) {
            i += l;
            textStart = i;
            break;
          }
        }
        i++;
      }
    }
  }
  flushText(len);
  processEmphasis(root);

  const out: Inline[] = [];
  for (let it: Item | null = head.next; it && it !== tail; it = it.next) {
    if (it.node) pushInline(out, it.node);
  }
  return out;
}

function isKeycapTail(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c === 0xfe0f || c === 0x20e3;
}
