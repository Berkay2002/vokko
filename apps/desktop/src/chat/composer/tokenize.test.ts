import { describe, expect, it } from 'vitest';
import { atomRanges, LineFlag, Mark, MAX_STYLED_LENGTH, plainLines, tokenize, type EditorLine, type TokenizeOptions } from './tokenize';

const has = (marks: number, bit: number) => (marks & bit) === bit;

/** The text of every segment with its marks, line by line. */
function segs(source: string, opts?: TokenizeOptions): [string, number][][] {
  return tokenize(source, opts).map(line => line.segments.map(s => [source.slice(s.start, s.end), s.marks] as [string, number]));
}

/** Marks of the segment(s) covering `needle` (the first occurrence), ANDed together. */
function marksOf(source: string, needle: string, opts?: TokenizeOptions): number {
  const at = source.indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  let marks = ~0;
  let found = 0;
  for (const line of tokenize(source, opts)) {
    for (const s of line.segments) {
      if (s.end <= at || s.start >= at + needle.length) continue;
      marks &= s.marks;
      found++;
    }
  }
  expect(found).toBeGreaterThan(0);
  return marks;
}

function checkPartition(source: string, lines: EditorLine[]): void {
  expect(lines.map(l => source.slice(l.start, l.end)).join('\n')).toBe(source);
  let pos = 0;
  for (const line of lines) {
    expect(line.start).toBe(pos);
    let at = line.start;
    for (const s of line.segments) {
      expect(s.start).toBe(at);
      expect(s.end).toBeGreaterThan(s.start);
      at = s.end;
    }
    expect(at).toBe(line.end);
    pos = line.end + 1;
  }
}

describe('tokenize: partition', () => {
  const samples = [
    '',
    'plain',
    '\n',
    'a\n\nb\n',
    '**bold** and *it* and __u__ and ~~s~~ and ||sp|| and `code`',
    '> quote\n>>> big quote\nstill quoted',
    '```js\nconst a = 1;\n```\nafter',
    '```\nunterminated',
    '# h1\n## h2\n### h3\n-# small\n- item\n1. one\n',
    '[label](https://example.com) https://x.y/z <@123> <@&9> <#5> <:wave:77> <a:dance:78> <t:1700000000:R> :smile:',
    '***bold italic*** **a *b* c** *a **b** c*',
    '\\*escaped\\* ** not bold ** * x *',
    '😀 **ü** ‮ rtl',
  ];
  it('segments tile every line and lines tile the source', () => {
    for (const s of samples) checkPartition(s, tokenize(s, { shortcodes: new Map([['smile', '😄']]) }));
  });

  it('holds for random input over the markdown alphabet', () => {
    const alphabet = ['*', '_', '~', '|', '`', '>', '#', '-', ' ', '\n', 'a', 'b', '[', ']', '(', ')', '<', '@', ':', '1', '.', 'h', 't', 'p', '/'];
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let n = 0; n < 400; n++) {
      let s = '';
      const len = Math.floor(rnd() * 40);
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      checkPartition(s, tokenize(s));
    }
  });

  it('skips styling above the limit', () => {
    const big = '*'.repeat(MAX_STYLED_LENGTH + 1);
    expect(tokenize(big)).toEqual(plainLines(big));
  });
});

describe('tokenize: inline styles', () => {
  it('bold keeps its delimiters, dimmed', () => {
    expect(segs('**hi**')).toEqual([[['**', Mark.Syntax], ['hi', Mark.Bold], ['**', Mark.Syntax]]]);
  });

  it('italic with * and _', () => {
    expect(has(marksOf('*it*', 'it'), Mark.Italic)).toBe(true);
    expect(has(marksOf('_it_', 'it'), Mark.Italic)).toBe(true);
  });

  it('underline, strike, spoiler', () => {
    expect(has(marksOf('__u__', 'u'), Mark.Underline)).toBe(true);
    expect(has(marksOf('~~s~~', 's'), Mark.Strike)).toBe(true);
    expect(has(marksOf('||sp||', 'sp'), Mark.Spoiler)).toBe(true);
  });

  it('inline code is monospace and its content is not parsed', () => {
    const m = marksOf('`**x**`', '**x**');
    expect(has(m, Mark.Code)).toBe(true);
    expect(has(m, Mark.Bold)).toBe(false);
    expect(has(marksOf('`a`', '`'), Mark.Syntax)).toBe(true);
  });

  it('nests styles', () => {
    const m = marksOf('**a *b* c**', 'b');
    expect(has(m, Mark.Bold)).toBe(true);
    expect(has(m, Mark.Italic)).toBe(true);
    expect(has(marksOf('**a *b* c**', 'a '), Mark.Italic)).toBe(false);
  });

  it('triple stars are bold and italic', () => {
    const m = marksOf('***x***', 'x');
    expect(has(m, Mark.Bold) && has(m, Mark.Italic)).toBe(true);
  });

  it('an unclosed delimiter styles nothing', () => {
    expect(has(marksOf('**open', 'open'), Mark.Bold)).toBe(false);
    expect(has(marksOf('a * b * c', 'b'), Mark.Italic)).toBe(false);
  });

  it('a backslash escape is not a delimiter', () => {
    expect(has(marksOf('\\*not\\*', 'not'), Mark.Italic)).toBe(false);
  });

  it('masked links: label plain, url link-coloured', () => {
    const src = '[label](https://example.com)';
    expect(has(marksOf(src, 'https://example.com'), Mark.Link)).toBe(true);
    expect(has(marksOf(src, 'label'), Mark.Link)).toBe(false);
    expect(has(marksOf(src, '['), Mark.Syntax)).toBe(true);
  });

  it('bare urls are link-coloured', () => {
    expect(has(marksOf('see https://example.com/a now', 'https://example.com/a'), Mark.Link)).toBe(true);
    expect(has(marksOf('see https://example.com/a now', 'see'), Mark.Link)).toBe(false);
  });
});

describe('tokenize: blocks', () => {
  it('quote: the prefix is the bar, the body is a quote line', () => {
    const lines = tokenize('> hi');
    expect(lines[0]!.flags & LineFlag.Quote).toBeTruthy();
    expect(has(lines[0]!.segments[0]!.marks, Mark.QuoteMark)).toBe(true);
  });

  it('>>> quotes the rest of the message', () => {
    const lines = tokenize('>>> a\nb\nc');
    expect(lines.every(l => l.flags & LineFlag.Quote)).toBe(true);
    expect(lines[1]!.flags & LineFlag.QuoteBody).toBeTruthy();
  });

  it('headings and subtext keep their prefix dimmed and flag the line', () => {
    const h = tokenize('## title');
    expect(h[0]!.flags & LineFlag.Heading).toBeTruthy();
    expect(has(h[0]!.segments[0]!.marks, Mark.Syntax)).toBe(true);
    const s = tokenize('-# small');
    expect(s[0]!.flags & LineFlag.Subtext).toBeTruthy();
  });

  it('a heading needs the space and some text', () => {
    expect(tokenize('#nope')[0]!.flags & LineFlag.Heading).toBeFalsy();
    expect(tokenize('# ')[0]!.flags & LineFlag.Heading).toBeFalsy();
  });

  it('a bullet is dimmed, an ordered list number is not', () => {
    expect(has(marksOf('- item', '-'), Mark.Syntax)).toBe(true);
    expect(has(marksOf('1. item', '1.'), Mark.Syntax)).toBe(false);
    expect(tokenize('1. item')[0]!.flags & LineFlag.List).toBeTruthy();
  });

  it('lists', () => {
    expect(tokenize('- a')[0]!.flags & LineFlag.List).toBeTruthy();
    expect(tokenize('1. a')[0]!.flags & LineFlag.List).toBeTruthy();
    expect(tokenize('-a')[0]!.flags & LineFlag.List).toBeFalsy();
  });

  it('fenced code: every line is code, the body is not parsed, highlight classes apply', () => {
    const src = '```js\nlet **x** = 1\n```';
    const lines = tokenize(src, { highlight: (code, lang) => (lang === 'js' ? [{ start: code.indexOf('let'), end: code.indexOf('let') + 3, cls: 'hljs-keyword' }] : []) });
    expect(lines).toHaveLength(3);
    expect(lines.every(l => l.flags & LineFlag.Code)).toBe(true);
    expect(lines[1]!.segments.some(s => s.hl === 'hljs-keyword' && src.slice(s.start, s.end) === 'let')).toBe(true);
    expect(has(marksOf(src, '**x**'), Mark.Bold)).toBe(false);
  });

  it('an unterminated fence is not code (the sent message would not render it as code either)', () => {
    const lines = tokenize('```\nfoo');
    expect(lines[1]!.flags & LineFlag.Code).toBeFalsy();
  });

  it('inline text after a closed fence is parsed again', () => {
    const lines = tokenize('```\nx\n```\n**b**');
    expect(lines[3]!.flags & LineFlag.Code).toBeFalsy();
    expect(has(lines[3]!.segments[1]!.marks, Mark.Bold)).toBe(true);
  });
});

describe('tokenize: atoms', () => {
  it('user, role and channel mentions are single atoms', () => {
    const src = '<@123> <@&9> <#5>';
    const lines = tokenize(src);
    const atoms = lines[0]!.segments.filter(s => s.atom).map(s => [src.slice(s.start, s.end), s.atom!.kind]);
    expect(atoms).toEqual([['<@123>', 'user'], ['<@&9>', 'role'], ['<#5>', 'channel']]);
  });

  it('custom emoji, animated emoji and timestamps', () => {
    const src = '<:wave:77><a:dance:78><t:1700000000:R>';
    const kinds = tokenize(src)[0]!.segments.map(s => s.atom?.kind);
    expect(kinds).toEqual(['emoji', 'emoji', 'timestamp']);
    expect(tokenize(src)[0]!.segments[1]!.atom).toMatchObject({ animated: true, name: 'dance' });
  });

  it('shortcodes resolve only when known', () => {
    const opts = { shortcodes: new Map([['smile', '😄']]) };
    expect(tokenize(':smile:', opts)[0]!.segments[0]!.atom).toMatchObject({ kind: 'shortcode', unicode: '😄' });
    expect(tokenize(':unknown:', opts)[0]!.segments.every(s => !s.atom)).toBe(true);
  });

  it('picked display mentions are chips; the same text typed without picking is not', () => {
    const picked = tokenize('hi @Alice!', { mentions: ['@Alice'] })[0]!.segments;
    expect(picked.some(s => s.atom === null && has(s.marks, Mark.Mention))).toBe(true);
    expect(tokenize('hi @Alice!')[0]!.segments.some(s => has(s.marks, Mark.Mention))).toBe(false);
  });

  it('atoms inside code are plain text', () => {
    expect(atomRanges(tokenize('`<@123>`'))).toEqual([]);
    expect(atomRanges(tokenize('```\n<@123>\n```'))).toEqual([]);
  });

  it('atomRanges lists atom spans in source order', () => {
    expect(atomRanges(tokenize('a <@1> b\n<#2>'))).toEqual([[2, 6], [9, 13]]);
  });
});

describe('plainLines', () => {
  it('splits on newlines and keeps empty lines', () => {
    const lines = plainLines('a\n\nb');
    expect(lines.map(l => [l.start, l.end, l.segments.length])).toEqual([[0, 1, 1], [2, 2, 0], [3, 4, 1]]);
  });
});
