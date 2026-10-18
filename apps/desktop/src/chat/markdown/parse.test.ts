import { describe, expect, it } from 'vitest';
import type { Block, Inline } from './ast';
import { isJumbo, parseMarkdown } from './parse';

const text = (v: string): Inline => ({ t: 'text', v });

/** inlines of the first (paragraph) block */
function inl(src: string, shortcodes?: ReadonlyMap<string, string>): Inline[] {
  const blocks = parseMarkdown(src, shortcodes ? { emojiShortcodes: shortcodes } : undefined);
  const b = blocks[0];
  if (!b || b.t !== 'paragraph') throw new Error(`expected paragraph, got ${JSON.stringify(blocks)}`);
  return b.c;
}

function depth(nodes: (Inline | Block)[]): number {
  let max = 0;
  for (const n of nodes) {
    const kids = 'c' in n && Array.isArray(n.c) ? (n.c as (Inline | Block)[]) : [];
    max = Math.max(max, 1 + depth(kids));
  }
  return max;
}

describe('inline formatting', () => {
  it('plain text', () => {
    expect(inl('hello world')).toEqual([text('hello world')]);
  });

  it('bold / italic (* and _) / underline / strike / spoiler', () => {
    expect(inl('**b**')).toEqual([{ t: 'bold', c: [text('b')] }]);
    expect(inl('*i*')).toEqual([{ t: 'italic', c: [text('i')] }]);
    expect(inl('_i_')).toEqual([{ t: 'italic', c: [text('i')] }]);
    expect(inl('__u__')).toEqual([{ t: 'underline', c: [text('u')] }]);
    expect(inl('~~s~~')).toEqual([{ t: 'strike', c: [text('s')] }]);
    expect(inl('||sp||')).toEqual([{ t: 'spoiler', c: [text('sp')] }]);
  });

  it('formatting inside surrounding text', () => {
    expect(inl('a **b** c')).toEqual([text('a '), { t: 'bold', c: [text('b')] }, text(' c')]);
  });

  it('nesting: ***bold italic***, **bold _italic_**, __*u i*__', () => {
    expect(inl('***x***')).toEqual([{ t: 'italic', c: [{ t: 'bold', c: [text('x')] }] }]);
    expect(inl('**bold _italic_**')).toEqual([
      { t: 'bold', c: [text('bold '), { t: 'italic', c: [text('italic')] }] },
    ]);
    expect(inl('__*x*__')).toEqual([{ t: 'underline', c: [{ t: 'italic', c: [text('x')] }] }]);
    expect(inl('||**x** `c`||')).toEqual([
      { t: 'spoiler', c: [{ t: 'bold', c: [text('x')] }, text(' '), { t: 'code', v: 'c' }] },
    ]);
  });

  it('backslash escapes ASCII punctuation', () => {
    expect(inl('\\*not italic\\*')).toEqual([text('*not italic*')]);
    expect(inl('\\_a\\_')).toEqual([text('_a_')]);
    expect(inl('\\\\')).toEqual([text('\\')]);
    expect(inl('\\#')).toEqual([text('#')]);
    expect(inl('\\`x\\`')).toEqual([text('`x`')]);
    expect(inl('\\a')).toEqual([text('\\a')]); // non-punctuation: backslash stays
    expect(inl('**a\\*b**')).toEqual([{ t: 'bold', c: [text('a*b')] }]);
  });

  it('escaped markers are not mentions or links', () => {
    expect(inl('\\@everyone')).toEqual([text('@everyone')]);
  });

  it('unclosed markers stay literal', () => {
    expect(inl('**bold')).toEqual([text('**bold')]);
    expect(inl('*a')).toEqual([text('*a')]);
    expect(inl('~~strike')).toEqual([text('~~strike')]);
    expect(inl('||secret')).toEqual([text('||secret')]);
    expect(inl('a * b * c')).toEqual([text('a * b * c')]);
    expect(inl('`open')).toEqual([text('`open')]);
    expect(inl('[a](')).toEqual([text('[a](')]);
    expect(inl('~ single ~')).toEqual([text('~ single ~')]);
    expect(inl('| single |')).toEqual([text('| single |')]);
  });

  it('snake_case_word is not italic', () => {
    expect(inl('snake_case_word')).toEqual([text('snake_case_word')]);
    expect(inl('use my_var_name here')).toEqual([text('use my_var_name here')]);
    expect(inl('_italic_ and snake_case')).toEqual([{ t: 'italic', c: [text('italic')] }, text(' and snake_case')]);
  });

  it('inline code (single and double backticks), nothing parsed inside', () => {
    expect(inl('`a*b*`')).toEqual([{ t: 'code', v: 'a*b*' }]);
    expect(inl('`**x** <@1> https://a.b`')).toEqual([{ t: 'code', v: '**x** <@1> https://a.b' }]);
    expect(inl('``a`b``')).toEqual([{ t: 'code', v: 'a`b' }]);
    expect(inl('`` `x` ``')).toEqual([{ t: 'code', v: '`x`' }]);
    expect(inl('a `b` c')).toEqual([text('a '), { t: 'code', v: 'b' }, text(' c')]);
  });

  it('code spans win over emphasis delimiters', () => {
    expect(inl('*a `*` b*')).toEqual([{ t: 'italic', c: [text('a '), { t: 'code', v: '*' }, text(' b')] }]);
  });

  it('newlines become br', () => {
    expect(inl('a\nb')).toEqual([text('a'), { t: 'br' }, text('b')]);
    expect(inl('*a\nb*')).toEqual([{ t: 'italic', c: [text('a'), { t: 'br' }, text('b')] }]);
  });

  it('raw HTML is just text', () => {
    expect(inl('<script>alert(1)</script>')).toEqual([text('<script>alert(1)</script>')]);
    expect(inl('<img src=x onerror=alert(1)>')).toEqual([text('<img src=x onerror=alert(1)>')]);
  });
});

describe('links', () => {
  it('autolinks http(s)', () => {
    expect(inl('see https://example.com/a?b=c now')).toEqual([
      text('see '),
      { t: 'link', href: 'https://example.com/a?b=c', c: [text('https://example.com/a?b=c')], masked: false },
      text(' now'),
    ]);
    expect(inl('http://x.io')).toEqual([{ t: 'link', href: 'http://x.io', c: [text('http://x.io')], masked: false }]);
  });

  it('strips trailing punctuation unless balanced', () => {
    const href = (s: string) => (inl(s).find((n) => n.t === 'link') as { href: string }).href;
    expect(href('go to https://example.com.')).toBe('https://example.com');
    expect(href('https://example.com, and')).toBe('https://example.com');
    expect(href('really https://example.com/x?!')).toBe('https://example.com/x');
    expect(href('(https://example.com)')).toBe('https://example.com');
    expect(href('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(href('(https://en.wikipedia.org/wiki/Foo_(bar))')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(inl('(https://example.com).')).toEqual([
      text('('),
      { t: 'link', href: 'https://example.com', c: [text('https://example.com')], masked: false },
      text(').'),
    ]);
  });

  it('url inside emphasis keeps the markers outside', () => {
    expect(inl('**https://example.com**')).toEqual([
      { t: 'bold', c: [{ t: 'link', href: 'https://example.com', c: [text('https://example.com')], masked: false }] },
    ]);
  });

  it('does not autolink mid-word or bare scheme', () => {
    expect(inl('xhttps://a.b')).toEqual([text('xhttps://a.b')]);
    expect(inl('https://')).toEqual([text('https://')]);
    expect(inl('ftp://example.com')).toEqual([text('ftp://example.com')]);
  });

  it('angle autolinks', () => {
    expect(inl('<https://example.com/x>')).toEqual([
      { t: 'link', href: 'https://example.com/x', c: [text('https://example.com/x')], masked: false },
    ]);
  });

  it('masked links', () => {
    expect(inl('[text](https://example.com)')).toEqual([
      { t: 'link', href: 'https://example.com', c: [text('text')], masked: true },
    ]);
    expect(inl('[**b** i](https://example.com/a_(b))')).toEqual([
      { t: 'link', href: 'https://example.com/a_(b)', c: [{ t: 'bold', c: [text('b')] }, text(' i')], masked: true },
    ]);
    expect(inl('[m](mailto:a@b.co)')).toEqual([{ t: 'link', href: 'mailto:a@b.co', c: [text('m')], masked: true }]);
    expect(inl('[t](<https://example.com/x>)')).toEqual([
      { t: 'link', href: 'https://example.com/x', c: [text('t')], masked: true },
    ]);
    expect(inl('[t](https://example.com "title")')).toEqual([
      { t: 'link', href: 'https://example.com', c: [text('t')], masked: true },
    ]);
  });

  it('masked link scheme filtering: only http/https/mailto', () => {
    expect(inl('[x](javascript:alert(1))')).toEqual([text('[x](javascript:alert(1))')]);
    expect(inl('[x](JAVASCRIPT:alert(1))')).toEqual([text('[x](JAVASCRIPT:alert(1))')]);
    expect(inl('[x](data:text/html;base64,AAAA)')).toEqual([text('[x](data:text/html;base64,AAAA)')]);
    expect(inl('[x](ftp://example.com)')).toEqual([text('[x](ftp://example.com)')]);
    expect(inl('[x](//example.com)')).toEqual([text('[x](//example.com)')]);
    expect(inl('[x](file:///etc/passwd)')).toEqual([text('[x](file:///etc/passwd)')]);
  });

  it('links never nest', () => {
    const nodes = inl('[see https://a.com](https://b.com)');
    expect(nodes).toEqual([
      { t: 'link', href: 'https://b.com', c: [text('see https://a.com')], masked: true },
    ]);
  });
});

describe('mentions, timestamps, emoji', () => {
  it('user / nickname / role / channel mentions', () => {
    expect(inl('<@123>')).toEqual([{ t: 'mention', kind: 'user', id: '123' }]);
    expect(inl('<@!123>')).toEqual([{ t: 'mention', kind: 'user', id: '123' }]);
    expect(inl('<@&55>')).toEqual([{ t: 'mention', kind: 'role', id: '55' }]);
    expect(inl('<#9>')).toEqual([{ t: 'mention', kind: 'channel', id: '9' }]);
    expect(inl('hi <@1>, see <#2>')).toEqual([
      text('hi '),
      { t: 'mention', kind: 'user', id: '1' },
      text(', see '),
      { t: 'mention', kind: 'channel', id: '2' },
    ]);
  });

  it('malformed mentions stay text', () => {
    expect(inl('<@abc>')).toEqual([text('<@abc>')]);
    expect(inl('<@>')).toEqual([text('<@>')]);
    expect(inl('<@12')).toEqual([text('<@12')]);
  });

  it('@everyone / @here', () => {
    expect(inl('@everyone')).toEqual([{ t: 'everyone' }]);
    expect(inl('hey @here!')).toEqual([text('hey '), { t: 'here' }, text('!')]);
    expect(inl('@everyoneelse')).toEqual([text('@everyoneelse')]);
    expect(inl('mail me@here.com')).toEqual([text('mail me@here.com')]);
  });

  it('timestamps (default style f)', () => {
    expect(inl('<t:1700000000>')).toEqual([{ t: 'timestamp', unix: 1700000000, style: 'f' }]);
    expect(inl('<t:1700000000:R>')).toEqual([{ t: 'timestamp', unix: 1700000000, style: 'R' }]);
    expect(inl('<t:1700000000:D>')).toEqual([{ t: 'timestamp', unix: 1700000000, style: 'D' }]);
    expect(inl('<t:1700000000:x>')).toEqual([text('<t:1700000000:x>')]);
  });

  it('custom emoji', () => {
    expect(inl('<:pog:123456>')).toEqual([{ t: 'customEmoji', name: 'pog', id: '123456', animated: false }]);
    expect(inl('<a:dance:99>')).toEqual([{ t: 'customEmoji', name: 'dance', id: '99', animated: true }]);
  });

  it('unicode emoji', () => {
    expect(inl('hi 😀!')).toEqual([text('hi '), { t: 'emoji', unicode: '😀' }, text('!')]);
  });

  it('ZWJ sequence, flag, skin tone, keycap are single nodes', () => {
    const family = '👨‍👩‍👧‍👦';
    expect(inl(family)).toEqual([{ t: 'emoji', unicode: family }]);
    expect(inl('🇸🇪')).toEqual([{ t: 'emoji', unicode: '🇸🇪' }]);
    expect(inl('👍🏽')).toEqual([{ t: 'emoji', unicode: '👍🏽' }]);
    expect(inl('1️⃣')).toEqual([{ t: 'emoji', unicode: '1️⃣' }]);
    expect(inl('❤️')).toEqual([{ t: 'emoji', unicode: '❤️' }]);
    expect(inl('a1b')).toEqual([text('a1b')]);
  });

  const codes = new Map([
    ['smile', '😄'],
    ['+1', '👍'],
  ]);

  it(':shortcode: resolves only with a map', () => {
    expect(inl(':smile:')).toEqual([text(':smile:')]);
    expect(inl(':smile: x', codes)).toEqual([{ t: 'emoji', unicode: '😄', name: 'smile' }, text(' x')]);
    expect(inl(':+1:', codes)).toEqual([{ t: 'emoji', unicode: '👍', name: '+1' }]);
    expect(inl(':nope:', codes)).toEqual([text(':nope:')]);
    expect(inl('12:30:45', codes)).toEqual([text('12:30:45')]);
  });
});

describe('blocks', () => {
  it('headings 1..3 at line start only', () => {
    expect(parseMarkdown('# One')).toEqual([{ t: 'heading', level: 1, c: [text('One')] }]);
    expect(parseMarkdown('## Two **b**')).toEqual([
      { t: 'heading', level: 2, c: [text('Two '), { t: 'bold', c: [text('b')] }] },
    ]);
    expect(parseMarkdown('### Three')).toEqual([{ t: 'heading', level: 3, c: [text('Three')] }]);
    expect(parseMarkdown('#### Four')).toEqual([{ t: 'paragraph', c: [text('#### Four')] }]);
    expect(parseMarkdown('#nospace')).toEqual([{ t: 'paragraph', c: [text('#nospace')] }]);
    expect(parseMarkdown('a # b')).toEqual([{ t: 'paragraph', c: [text('a # b')] }]);
    expect(parseMarkdown(' # indented')).toEqual([{ t: 'paragraph', c: [text(' # indented')] }]);
  });

  it('heading ends a paragraph and starts the next', () => {
    expect(parseMarkdown('hello\n# T\nbye')).toEqual([
      { t: 'paragraph', c: [text('hello')] },
      { t: 'heading', level: 1, c: [text('T')] },
      { t: 'paragraph', c: [text('bye')] },
    ]);
  });

  it('subtext', () => {
    expect(parseMarkdown('-# small print')).toEqual([{ t: 'subtext', c: [text('small print')] }]);
    expect(parseMarkdown('-#nospace')).toEqual([{ t: 'paragraph', c: [text('-#nospace')] }]);
  });

  it('lists', () => {
    expect(parseMarkdown('- a\n- b **x**\n* c')).toEqual([
      {
        t: 'list',
        ordered: false,
        start: 1,
        items: [{ c: [text('a')] }, { c: [text('b '), { t: 'bold', c: [text('x')] }] }, { c: [text('c')] }],
      },
    ]);
    expect(parseMarkdown('1. one\n2. two')).toEqual([
      { t: 'list', ordered: true, start: 1, items: [{ c: [text('one')] }, { c: [text('two')] }] },
    ]);
    expect(parseMarkdown('3. three\n4. four')).toEqual([
      { t: 'list', ordered: true, start: 3, items: [{ c: [text('three')] }, { c: [text('four')] }] },
    ]);
    // markers need a space: not a list
    expect(parseMarkdown('-a')).toEqual([{ t: 'paragraph', c: [text('-a')] }]);
    expect(parseMarkdown('*a*')).toEqual([{ t: 'paragraph', c: [{ t: 'italic', c: [text('a')] }] }]);
  });

  it('nested lists', () => {
    const li = (v: string, sub?: unknown[]) => (sub ? { c: [text(v)], sub } : { c: [text(v)] });
    expect(parseMarkdown('- item a\n  - nested b\n    - deeper c\n- back d')).toEqual([
      { t: 'list', ordered: false, start: 1, items: [
        li('item a', [{ t: 'list', ordered: false, start: 1, items: [li('nested b', [{ t: 'list', ordered: false, start: 1, items: [li('deeper c')] }])] }]),
        li('back d'),
      ] },
    ]);
    // an ordered list under a bullet, then one space of indent is still a sibling
    expect(parseMarkdown('- a\n  1. one\n  2. two\n - b')).toEqual([
      { t: 'list', ordered: false, start: 1, items: [
        li('a', [{ t: 'list', ordered: true, start: 1, items: [li('one'), li('two')] }]),
        li('b'),
      ] },
    ]);
    // a mixed marker at the same level starts a new top-level list, as before
    expect(parseMarkdown('- a\n1. b')).toEqual([
      { t: 'list', ordered: false, start: 1, items: [li('a')] },
      { t: 'list', ordered: true, start: 1, items: [li('b')] },
    ]);
  });

  it('list after text, then text', () => {
    expect(parseMarkdown('intro\n- a\nafter')).toEqual([
      { t: 'paragraph', c: [text('intro')] },
      { t: 'list', ordered: false, start: 1, items: [{ c: [text('a')] }] },
      { t: 'paragraph', c: [text('after')] },
    ]);
  });

  it('single-line and multi-line quotes', () => {
    expect(parseMarkdown('> hi')).toEqual([{ t: 'quote', c: [{ t: 'paragraph', c: [text('hi')] }] }]);
    expect(parseMarkdown('> a\n> b\nplain')).toEqual([
      { t: 'quote', c: [{ t: 'paragraph', c: [text('a'), { t: 'br' }, text('b')] }] },
      { t: 'paragraph', c: [text('plain')] },
    ]);
    expect(parseMarkdown('>no space')).toEqual([{ t: 'paragraph', c: [text('>no space')] }]);
    expect(parseMarkdown('> **b**')).toEqual([
      { t: 'quote', c: [{ t: 'paragraph', c: [{ t: 'bold', c: [text('b')] }] }] },
    ]);
  });

  it('>>> swallows the rest of the message', () => {
    expect(parseMarkdown('before\n>>> a\nb\n> c\n# d')).toEqual([
      { t: 'paragraph', c: [text('before')] },
      {
        t: 'quote',
        c: [{ t: 'paragraph', c: [text('a'), { t: 'br' }, text('b'), { t: 'br' }, text('> c')] }, { t: 'heading', level: 1, c: [text('d')] }],
      },
    ]);
  });

  it('quotes do not nest', () => {
    expect(parseMarkdown('> > x')).toEqual([{ t: 'quote', c: [{ t: 'paragraph', c: [text('> x')] }] }]);
  });

  it('code blocks', () => {
    expect(parseMarkdown('```js\nconst a = 1;\n```')).toEqual([{ t: 'codeblock', lang: 'js', v: 'const a = 1;' }]);
    expect(parseMarkdown('```\nplain\n```')).toEqual([{ t: 'codeblock', lang: null, v: 'plain' }]);
    expect(parseMarkdown('```inline```')).toEqual([{ t: 'codeblock', lang: null, v: 'inline' }]);
    expect(parseMarkdown('```js foo```')).toEqual([{ t: 'codeblock', lang: null, v: 'js foo' }]);
    expect(parseMarkdown('hi\n```py\nx\n\ny\n```\nbye')).toEqual([
      { t: 'paragraph', c: [text('hi')] },
      { t: 'codeblock', lang: 'py', v: 'x\n\ny' },
      { t: 'paragraph', c: [text('bye')] },
    ]);
  });

  it('nothing is parsed inside a code block', () => {
    expect(parseMarkdown('```\n**b** # h > q <@1> - l\n```')).toEqual([
      { t: 'codeblock', lang: null, v: '**b** # h > q <@1> - l' },
    ]);
  });

  it('unclosed fence stays text', () => {
    const blocks = parseMarkdown('```js\nconst a = 1;');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.t).toBe('paragraph');
  });

  it('code block inside a quote', () => {
    expect(parseMarkdown('> ```\n> code\n> ```')).toEqual([
      { t: 'quote', c: [{ t: 'codeblock', lang: null, v: 'code' }] },
    ]);
  });

  it('CRLF is normalised', () => {
    expect(parseMarkdown('a\r\nb')).toEqual([{ t: 'paragraph', c: [text('a'), { t: 'br' }, text('b')] }]);
  });

  it('empty input', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n')).toEqual([]);
  });
});

describe('isJumbo', () => {
  const jumbo = (s: string, codes?: ReadonlyMap<string, string>) =>
    isJumbo(parseMarkdown(s, codes ? { emojiShortcodes: codes } : undefined));

  it('true for emoji-only messages', () => {
    expect(jumbo('😀')).toBe(true);
    expect(jumbo('😀 😀😀')).toBe(true);
    expect(jumbo('😀\n😀')).toBe(true);
    expect(jumbo('<:aa:12345> 😀')).toBe(true);
    expect(jumbo(':smile:', new Map([['smile', '😄']]))).toBe(true);
    expect(jumbo('👨‍👩‍👧‍👦')).toBe(true);
  });

  it('false otherwise', () => {
    expect(jumbo('')).toBe(false);
    expect(jumbo('hi 😀')).toBe(false);
    expect(jumbo('😀 hi')).toBe(false);
    expect(jumbo('**😀**')).toBe(false);
    expect(jumbo('# 😀')).toBe(false);
    expect(jumbo('> 😀')).toBe(false);
    expect(jumbo('😀 <@1>')).toBe(false);
    expect(jumbo('😀\n# x')).toBe(false);
    expect(jumbo('😀'.repeat(31))).toBe(false);
    expect(jumbo(':smile:')).toBe(false); // no map: literal text
  });

  it('up to 30 emoji is still jumbo', () => {
    expect(jumbo('😀'.repeat(30))).toBe(true);
  });
});

describe('robustness', () => {
  // small deterministic PRNG (mulberry32)
  function rng(seed: number) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const pieces = [
    '*', '**', '***', '_', '__', '~', '~~', '|', '||', '`', '``', '```', '[', ']', '(', ')', '<', '>', '<@', '<@1>', '<#2>',
    '<t:1:R>', '<a:x:1>', ':', ':smile:', '\\', '\n', '\n\n', ' ', '# ', '## ', '-# ', '- ', '1. ', '> ', '>>> ', 'a', 'b', 'snake_case',
    'http://', 'https://x.y', '@everyone', '@here', '😀', '👨‍👩‍👧‍👦', '1️⃣', '\uD83D', '\uDE00', '\u0000', 'é', '字', '<script>', '&amp;',
  ];

  it('never throws on random input (fuzz)', () => {
    const r = rng(1234);
    const codes = new Map([['smile', '😄']]);
    for (let n = 0; n < 4000; n++) {
      const count = 1 + Math.floor(r() * 40);
      let s = '';
      for (let k = 0; k < count; k++) s += pieces[Math.floor(r() * pieces.length)];
      const blocks = parseMarkdown(s, n % 2 ? { emojiShortcodes: codes } : undefined);
      isJumbo(blocks);
      JSON.stringify(blocks);
    }
  });

  it('never throws on random code units', () => {
    const r = rng(99);
    for (let n = 0; n < 500; n++) {
      let s = '';
      const len = Math.floor(r() * 300);
      for (let k = 0; k < len; k++) s += String.fromCharCode(Math.floor(r() * 0xffff));
      parseMarkdown(s);
    }
  });

  const N = 100_000;
  const pathological: [string, string][] = [
    ['*'.repeat(N), 'runs of *'],
    ['_'.repeat(N), 'runs of _'],
    ['['.repeat(N), 'runs of ['],
    [']'.repeat(N), 'runs of ]'],
    ['*a'.repeat(N / 2), '*a*a*a'],
    ['a*'.repeat(N / 2), 'a*a*a*'],
    ['*a_'.repeat(N / 3), 'mixed * and _'],
    ['**a*'.repeat(N / 4), 'rule of three mix'],
    ['[a]('.repeat(N / 4), '[a]( repeated'],
    ['[a](x'.repeat(N / 5), '[a](x repeated'],
    ['[*'.repeat(N / 2), '[* repeated'],
    ['*['.repeat(N / 2), '*[ repeated'],
    ['`'.repeat(N), 'runs of `'],
    ['`a``b```'.repeat(N / 8), 'varying backtick runs'],
    ['~~a'.repeat(N / 3), '~~a repeated'],
    ['||a'.repeat(N / 3), '||a repeated'],
    ['<@'.repeat(N / 2), '<@ repeated'],
    ['<@1'.repeat(N / 3), '<@1 repeated'],
    ['https://'.repeat(N / 8), 'https:// repeated'],
    ['https://.'.repeat(N / 9) + ' ', 'https://. repeated'],
    [':'.repeat(N), 'runs of :'],
    ['a:'.repeat(N / 2), 'a: repeated'],
    ['> '.repeat(N / 2), '> repeated'],
    ['> a\n'.repeat(N / 4), 'quote lines'],
    ['- a\n'.repeat(N / 4), 'list lines'],
    ['```\n'.repeat(N / 4), 'fences'],
    ['```a'.repeat(N / 4), 'inline fences'],
    ['\n'.repeat(N), 'newlines'],
    ['```\n' + '\n'.repeat(N) + '```', 'newlines in fence'],
    ['\\'.repeat(N), 'backslashes'],
    ['😀'.repeat(N / 2), 'emoji'],
    ['字'.repeat(N), 'cjk'],
    ['*'.repeat(N / 2) + 'a' + '*'.repeat(N / 2), 'deep nesting'],
    ['*_~|'.repeat(N / 4), 'every delimiter'],
    ['[' + '*a'.repeat(N / 4) + '](https://x.y)', 'huge link text'],
  ];

  for (const [src, label] of pathological) {
    it(`100k chars: ${label} finishes quickly`, () => {
      const t0 = performance.now();
      const blocks = parseMarkdown(src);
      const ms = performance.now() - t0;
      expect(blocks.length).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(1500);
    });
  }

  it('nesting depth stays bounded', () => {
    const blocks = parseMarkdown('*'.repeat(50_000) + 'a' + '*'.repeat(50_000));
    expect(depth(blocks)).toBeLessThan(40);
    const deep = parseMarkdown('**_~~||'.repeat(2000) + 'x' + '||~~_**'.repeat(2000));
    expect(depth(deep)).toBeLessThan(40);
  });
});
