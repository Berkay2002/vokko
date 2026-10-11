import {
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { Block, Inline } from './ast';
import { highlightToReact, languageLabel } from './highlight';
import { isJumbo, parseMarkdown } from './parse';

export interface MarkdownContext {
  /** null renders the fallback pill "@unknown-user" */
  userName(id: string): string | null;
  /** css colour of the user's top role (optional) */
  userColor?(id: string): string | undefined;
  roleInfo(id: string): { name: string; color: string | null } | null;
  channelName(id: string): string | null;
  currentUserId: string | null;
  emojiShortcodes?: ReadonlyMap<string, string>;
  customEmojiUrl?(id: string, animated: boolean): string;
  /** when given, a link click calls it with preventDefault (leaving-Vokko confirm) */
  onLink?(href: string): void;
  /** Keyboard activation (Enter/Space) passes the KeyboardEvent; use only ev.currentTarget. */
  onMention?(kind: 'user' | 'role' | 'channel', id: string, ev: MouseEvent): void;
  formatTimestamp?(unix: number, style: string): { text: string; title: string };
}

// ---------------------------------------------------------------------------------------------
// timestamps
// ---------------------------------------------------------------------------------------------

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function dateFormatter(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = dateFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, opts);
    dateFormatters.set(key, f);
  }
  return f;
}

const STYLE_OPTIONS: Record<string, Intl.DateTimeFormatOptions> = {
  t: { timeStyle: 'short' },
  T: { timeStyle: 'medium' },
  d: { year: 'numeric', month: '2-digit', day: '2-digit' },
  D: { dateStyle: 'long' },
  f: { dateStyle: 'long', timeStyle: 'short' },
  F: { dateStyle: 'full', timeStyle: 'short' },
};

function relativeText(unix: number): string {
  const diff = unix - Date.now() / 1000;
  const abs = Math.abs(diff);
  let unit: Intl.RelativeTimeFormatUnit;
  let value: number;
  if (abs < 60) {
    unit = 'second';
    value = diff;
  } else if (abs < 3600) {
    unit = 'minute';
    value = diff / 60;
  } else if (abs < 86400) {
    unit = 'hour';
    value = diff / 3600;
  } else if (abs < 2_592_000) {
    unit = 'day';
    value = diff / 86400;
  } else if (abs < 31_557_600) {
    unit = 'month';
    value = diff / 2_629_800;
  } else {
    unit = 'year';
    value = diff / 31_557_600;
  }
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'always' }).format(Math.trunc(value), unit);
}

/** Default timestamp formatter (user locale). Never throws. */
export function defaultFormatTimestamp(unix: number, style: string): { text: string; title: string } {
  const date = new Date(unix * 1000);
  if (!Number.isFinite(unix) || Number.isNaN(date.getTime())) {
    const raw = `<t:${unix}>`;
    return { text: raw, title: raw };
  }
  try {
    const title = dateFormatter('F', STYLE_OPTIONS.F!).format(date);
    if (style === 'R') return { text: relativeText(unix), title };
    const opts = STYLE_OPTIONS[style] ?? STYLE_OPTIONS.f!;
    return { text: dateFormatter(STYLE_OPTIONS[style] ? style : 'f', opts).format(date), title };
  } catch {
    const raw = `<t:${unix}>`;
    return { text: raw, title: raw };
  }
}

// ---------------------------------------------------------------------------------------------
// pieces
// ---------------------------------------------------------------------------------------------

function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (revealed) {
    return (
      <span className="md-spoiler" data-revealed="true">
        {children}
      </span>
    );
  }
  const reveal = (e: { preventDefault(): void; stopPropagation(): void }) => {
    e.preventDefault();
    e.stopPropagation();
    setRevealed(true);
  };
  return (
    <span
      className="md-spoiler"
      data-revealed="false"
      role="button"
      tabIndex={0}
      aria-label="Spoiler, activate to reveal"
      // capture: a click on a link inside a hidden spoiler reveals instead of navigating
      onClickCapture={reveal}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') reveal(e);
      }}
    >
      <span className="md-spoiler-content" aria-hidden="true">
        {children}
      </span>
    </span>
  );
}

function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  const label = languageLabel(lang);
  const body = useMemo(() => highlightToReact(code, lang), [code, lang]);
  return (
    <pre className="md-codeblock">
      {label ? <div className="md-codeblock-lang">{label}</div> : null}
      <code className="hljs">{body}</code>
    </pre>
  );
}

function Mention({
  kind,
  id,
  ctx,
}: {
  kind: 'user' | 'role' | 'channel';
  id: string;
  ctx: MarkdownContext;
}) {
  let text: string;
  let color: string | null | undefined;
  if (kind === 'user') {
    const name = ctx.userName(id);
    text = `@${name ?? 'unknown-user'}`;
    color = name !== null ? ctx.userColor?.(id) : undefined;
  } else if (kind === 'role') {
    const info = ctx.roleInfo(id);
    text = `@${info ? info.name : 'unknown-role'}`;
    color = info?.color;
  } else {
    const name = ctx.channelName(id);
    text = `#${name ?? 'unknown-channel'}`;
  }
  const self = kind === 'user' && ctx.currentUserId !== null && ctx.currentUserId === id;
  const style = color ? ({ '--md-mention-color': color } as CSSProperties) : undefined;
  const cls = `md-mention md-mention-${kind}`;
  const onMention = ctx.onMention;
  if (!onMention) {
    return (
      <span className={cls} data-self={self ? 'true' : undefined} style={style}>
        {text}
      </span>
    );
  }
  return (
    <span
      className={cls}
      data-self={self ? 'true' : undefined}
      style={style}
      role="button"
      tabIndex={0}
      onClick={(e) => onMention(kind, id, e)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onMention(kind, id, e as unknown as MouseEvent);
        }
      }}
    >
      {text}
    </span>
  );
}

function renderInline(nodes: Inline[], ctx: MarkdownContext, keyPrefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`;
    switch (node.t) {
      case 'text':
        return node.v;
      case 'br':
        return <br key={key} />;
      case 'bold':
        return <strong key={key}>{renderInline(node.c, ctx, `${key}.`)}</strong>;
      case 'italic':
        return <em key={key}>{renderInline(node.c, ctx, `${key}.`)}</em>;
      case 'underline':
        return <u key={key}>{renderInline(node.c, ctx, `${key}.`)}</u>;
      case 'strike':
        return <s key={key}>{renderInline(node.c, ctx, `${key}.`)}</s>;
      case 'spoiler':
        return <Spoiler key={key}>{renderInline(node.c, ctx, `${key}.`)}</Spoiler>;
      case 'code':
        return (
          <code key={key} className="md-code">
            {node.v}
          </code>
        );
      case 'link': {
        const href = node.href;
        const onLink = ctx.onLink;
        return (
          <a
            key={key}
            className="md-link"
            href={href}
            title={node.masked ? href : undefined}
            target="_blank"
            rel="noopener noreferrer"
            onClick={
              onLink
                ? (e) => {
                    e.preventDefault();
                    onLink(href);
                  }
                : undefined
            }
          >
            {renderInline(node.c, ctx, `${key}.`)}
          </a>
        );
      }
      case 'mention':
        return <Mention key={key} kind={node.kind} id={node.id} ctx={ctx} />;
      case 'everyone':
        return (
          <span key={key} className="md-mention md-mention-everyone">
            @everyone
          </span>
        );
      case 'here':
        return (
          <span key={key} className="md-mention md-mention-everyone">
            @here
          </span>
        );
      case 'timestamp': {
        const fmt = ctx.formatTimestamp ?? defaultFormatTimestamp;
        let r: { text: string; title: string };
        try {
          r = fmt(node.unix, node.style);
        } catch {
          r = defaultFormatTimestamp(node.unix, node.style);
        }
        const d = new Date(node.unix * 1000);
        return (
          <time
            key={key}
            className="md-timestamp"
            title={r.title}
            dateTime={Number.isNaN(d.getTime()) ? undefined : d.toISOString()}
          >
            {r.text}
          </time>
        );
      }
      case 'emoji':
        return (
          <span key={key} className="md-emoji" role="img" aria-label={node.name ?? node.unicode}>
            {node.unicode}
          </span>
        );
      case 'customEmoji': {
        const src = ctx.customEmojiUrl?.(node.id, node.animated);
        if (!src) return `:${node.name}:`;
        return (
          <img
            key={key}
            className="md-emoji md-emoji-custom"
            src={src}
            alt={`:${node.name}:`}
            title={`:${node.name}:`}
            draggable={false}
            loading="lazy"
          />
        );
      }
    }
  });
}

function renderBlocks(
  blocks: Block[],
  ctx: MarkdownContext,
  keyPrefix: string,
  /** rendered inline at the end of the last block when that block is a paragraph */
  suffix?: ReactNode,
): ReactNode[] {
  return blocks.map((b, i) => {
    const key = `${keyPrefix}${i}`;
    switch (b.t) {
      case 'paragraph':
        return (
          <p key={key} className="md-p">
            {renderInline(b.c, ctx, `${key}.`)}
            {i === blocks.length - 1 ? suffix : null}
          </p>
        );
      case 'heading': {
        const kids = renderInline(b.c, ctx, `${key}.`);
        if (b.level === 1) return <h1 key={key} className="md-h1">{kids}</h1>;
        if (b.level === 2) return <h2 key={key} className="md-h2">{kids}</h2>;
        return (
          <h3 key={key} className="md-h3">
            {kids}
          </h3>
        );
      }
      case 'subtext':
        return (
          <small key={key} className="md-subtext">
            {renderInline(b.c, ctx, `${key}.`)}
          </small>
        );
      case 'codeblock':
        return <CodeBlock key={key} lang={b.lang} code={b.v} />;
      case 'quote':
        return (
          <div key={key} className="md-quote">
            <div className="md-quote-bar" />
            <blockquote>{renderBlocks(b.c, ctx, `${key}.`)}</blockquote>
          </div>
        );
      case 'list': {
        const items = b.items.map((it, j) => <li key={j}>{renderInline(it, ctx, `${key}.${j}.`)}</li>);
        return b.ordered ? (
          <ol key={key} className="md-list" start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={key} className="md-list">
            {items}
          </ul>
        );
      }
    }
  });
}

export function Markdown(props: {
  content: string;
  ctx: MarkdownContext;
  className?: string;
  /** e.g. an "(edited)" marker: flows inline after a trailing paragraph, otherwise follows the blocks */
  suffix?: ReactNode;
}) {
  const { content, ctx, className, suffix } = props;
  const shortcodes = ctx.emojiShortcodes;
  const blocks = useMemo(
    () => parseMarkdown(content, shortcodes ? { emojiShortcodes: shortcodes } : undefined),
    [content, shortcodes],
  );
  const jumbo = isJumbo(blocks);
  const cls = `md${jumbo ? ' md-jumbo' : ''}${className ? ` ${className}` : ''}`;
  const lastIsParagraph = blocks.length > 0 && blocks[blocks.length - 1]!.t === 'paragraph';
  return (
    <div className={cls}>
      {renderBlocks(blocks, ctx, 'b', lastIsParagraph ? suffix : undefined)}
      {suffix && !lastIsParagraph ? <span className="md-suffix">{suffix}</span> : null}
    </div>
  );
}
