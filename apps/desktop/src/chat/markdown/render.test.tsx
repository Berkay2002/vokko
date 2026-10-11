import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { highlightToReact, languageLabel } from './highlight';
import { Markdown, defaultFormatTimestamp, type MarkdownContext } from './render';

const ctx: MarkdownContext = {
  userName: (id) => (id === '1' ? 'alice' : id === '2' ? 'bob' : null),
  roleInfo: (id) => (id === '10' ? { name: 'mods', color: '#ff0000' } : null),
  channelName: (id) => (id === '20' ? 'general' : null),
  currentUserId: '1',
  customEmojiUrl: (id, animated) => `https://cdn.test/emoji/${id}.${animated ? 'gif' : 'png'}`,
  formatTimestamp: (unix, style) => ({ text: `ts:${unix}:${style}`, title: `title:${unix}` }),
};

const html = (content: string, c: MarkdownContext = ctx, className?: string) =>
  renderToStaticMarkup(<Markdown content={content} ctx={c} className={className} />);

describe('Markdown render', () => {
  it('wraps in .md with className', () => {
    expect(html('hi', ctx, 'msg')).toBe('<div class="md msg"><p class="md-p">hi</p></div>');
    expect(html('hi')).toBe('<div class="md"><p class="md-p">hi</p></div>');
  });

  it('suffix flows inline after a trailing paragraph, else follows the blocks', () => {
    const s = <i>(edited)</i>;
    expect(renderToStaticMarkup(<Markdown content="hi" ctx={ctx} suffix={s} />)).toBe(
      '<div class="md"><p class="md-p">hi<i>(edited)</i></p></div>',
    );
    expect(renderToStaticMarkup(<Markdown content="# hi" ctx={ctx} suffix={s} />)).toBe(
      '<div class="md"><h1 class="md-h1">hi</h1><span class="md-suffix"><i>(edited)</i></span></div>',
    );
  });

  it('formatting elements', () => {
    const out = html('**b** *i* __u__ ~~s~~ `c`');
    expect(out).toContain('<strong>b</strong>');
    expect(out).toContain('<em>i</em>');
    expect(out).toContain('<u>u</u>');
    expect(out).toContain('<s>s</s>');
    expect(out).toContain('<code class="md-code">c</code>');
  });

  it('spoiler is a hidden button until clicked', () => {
    const out = html('||secret||');
    expect(out).toContain('class="md-spoiler"');
    expect(out).toContain('data-revealed="false"');
    expect(out).toContain('role="button"');
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('aria-hidden="true"');
  });

  it('escapes script and event-handler markup as text', () => {
    const a = html('<script>alert(1)</script>');
    expect(a).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(a).not.toContain('<script');
    const b = html('<img src=x onerror=alert(1)>');
    expect(b).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(b).not.toContain('<img');
    const c = html('[x](javascript:alert(1))');
    expect(c).not.toContain('<a');
    expect(c).toContain('[x](javascript:alert(1))');
    const d = html('"><svg onload=alert(1)>');
    expect(d).not.toContain('<svg');
  });

  it('links: default target/rel, onLink hook', () => {
    const out = html('[go](https://example.com/a?b=1&c=2) and https://x.io');
    expect(out).toContain('class="md-link"');
    expect(out).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('href="https://x.io"');
    // with onLink the anchor still carries the href (handler is attached client-side)
    const hooked = html('https://x.io', { ...ctx, onLink: () => {} });
    expect(hooked).toContain('href="https://x.io"');
  });

  it('mention pills', () => {
    const out = html('<@1> <@2> <@999> <@&10> <@&11> <#20> <#21> @everyone @here');
    expect(out).toContain('<span class="md-mention md-mention-user" data-self="true">@alice</span>');
    expect(out).toContain('<span class="md-mention md-mention-user">@bob</span>');
    expect(out).toContain('@unknown-user');
    expect(out).toContain('md-mention-role');
    expect(out).toContain('@mods');
    expect(out).toContain('--md-mention-color:#ff0000');
    expect(out).toContain('@unknown-role');
    expect(out).toContain('#general');
    expect(out).toContain('#unknown-channel');
    expect(out).toContain('<span class="md-mention md-mention-everyone">@everyone</span>');
    expect(out).toContain('<span class="md-mention md-mention-everyone">@here</span>');
  });

  it('clickable mentions are buttons only when onMention is given', () => {
    expect(html('<@2>')).not.toContain('role="button"');
    expect(html('<@2>', { ...ctx, onMention: () => {} })).toContain('role="button"');
  });

  it('timestamps', () => {
    const out = html('<t:1700000000:R>');
    expect(out).toContain('<time class="md-timestamp" title="title:1700000000"');
    expect(out).toContain('ts:1700000000:R');
    expect(html('<t:1700000000>')).toContain('ts:1700000000:f');
  });

  it('default timestamp formatter produces text and never throws', () => {
    const noFmt: MarkdownContext = { ...ctx, formatTimestamp: undefined };
    for (const style of ['t', 'T', 'd', 'D', 'f', 'F', 'R']) {
      const out = html(`<t:1700000000:${style}>`, noFmt);
      expect(out).toContain('<time class="md-timestamp"');
    }
    expect(html('<t:999999999999999>', noFmt)).toContain('md-timestamp');
    expect(defaultFormatTimestamp(Math.floor(Date.now() / 1000) + 3 * 3600 + 30, 'R').text).toMatch(/3 hours/);
    expect(defaultFormatTimestamp(Math.floor(Date.now() / 1000) - 2 * 86400 - 30, 'R').text).toMatch(/2 days ago/);
  });

  it('emoji: unicode, custom, jumbo', () => {
    const out = html('hi 😀 <:pog:5> <a:dance:6>');
    expect(out).toContain('<span class="md-emoji" role="img" aria-label="😀">😀</span>');
    expect(out).toContain('class="md-emoji md-emoji-custom"');
    expect(out).toContain('alt=":pog:"');
    expect(out).toContain('src="https://cdn.test/emoji/5.png"');
    expect(out).toContain('src="https://cdn.test/emoji/6.gif"');
    expect(out).not.toContain('md-jumbo');
    expect(html('😀 <:pog:5>')).toContain('class="md md-jumbo"');
  });

  it('shortcodes come from ctx', () => {
    const codes = new Map([['smile', '😄']]);
    expect(html(':smile:', { ...ctx, emojiShortcodes: codes })).toContain('aria-label="smile">😄</span>');
    expect(html(':smile:')).toContain(':smile:');
  });

  it('blocks: headings, subtext, quote, lists', () => {
    expect(html('# T')).toContain('<h1 class="md-h1">T</h1>');
    expect(html('## T')).toContain('<h2 class="md-h2">T</h2>');
    expect(html('### T')).toContain('<h3 class="md-h3">T</h3>');
    expect(html('-# s')).toContain('<small class="md-subtext">s</small>');
    expect(html('> q')).toContain(
      '<div class="md-quote"><div class="md-quote-bar"></div><blockquote><p class="md-p">q</p></blockquote></div>',
    );
    expect(html('- a\n- b')).toContain('<ul class="md-list"><li>a</li><li>b</li></ul>');
    expect(html('3. a\n4. b')).toContain('<ol class="md-list" start="3"><li>a</li><li>b</li></ol>');
  });

  it('code block: label, hljs classes, escaped content', () => {
    const out = html('```js\nconst a = "<b>";\n```');
    expect(out).toContain('<pre class="md-codeblock">');
    expect(out).toContain('<div class="md-codeblock-lang">JavaScript</div>');
    expect(out).toContain('<code class="hljs">');
    expect(out).toContain('hljs-keyword');
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toContain('<b>');
  });

  it('code block without a known language: no label, plain text', () => {
    const out = html('```\n<script>1</script>\n```');
    expect(out).not.toContain('md-codeblock-lang');
    expect(out).toContain('&lt;script&gt;1&lt;/script&gt;');
    const unknown = html('```klingon\nqapla\n```');
    expect(unknown).not.toContain('md-codeblock-lang');
  });
});

describe('highlight', () => {
  it('labels and aliases', () => {
    expect(languageLabel('js')).toBe('JavaScript');
    expect(languageLabel('TS')).toBe('TypeScript');
    expect(languageLabel('py')).toBe('Python');
    expect(languageLabel('html')).toBe('HTML');
    expect(languageLabel('rs')).toBe('Rust');
    expect(languageLabel('sh')).toBe('Bash');
    expect(languageLabel('cs')).toBe('C#');
    expect(languageLabel('yml')).toBe('YAML');
    expect(languageLabel('c++')).toBe('C++');
    expect(languageLabel('nope')).toBeNull();
    expect(languageLabel(null)).toBeNull();
    expect(languageLabel('constructor')).toBeNull();
    expect(languageLabel('__proto__')).toBeNull();
  });

  it('returns plain strings for unknown languages and React nodes for known ones', () => {
    expect(highlightToReact('x <y>', null)).toBe('x <y>');
    expect(highlightToReact('x <y>', 'nope')).toBe('x <y>');
    expect(Array.isArray(highlightToReact('let a = 1', 'ts'))).toBe(true);
  });

  it('all registered languages highlight without throwing', () => {
    const langs = ['javascript', 'typescript', 'json', 'python', 'rust', 'bash', 'css', 'xml', 'sql', 'go', 'java', 'c', 'cpp', 'csharp', 'yaml', 'markdown', 'diff'];
    for (const l of langs) {
      expect(() => renderToStaticMarkup(<code>{highlightToReact('a = 1 // x\n<b>"s"</b>', l)}</code>)).not.toThrow();
    }
  });
});
