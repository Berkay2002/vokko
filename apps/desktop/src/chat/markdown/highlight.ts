import { createElement, type ReactNode } from 'react';
import type { Element, RootContent } from 'hast';
import { createLowlight } from 'lowlight';
import { languageLabel, resolveLanguage } from './languages';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const lowlight = createLowlight({
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
});

const MAX_HIGHLIGHT_CHARS = 100_000;

export { languageLabel };

function toReact(nodes: RootContent[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.type === 'text') {
      out.push(node.value);
    } else if (node.type === 'element') {
      const el: Element = node;
      const cls = el.properties?.className;
      const className = Array.isArray(cls) ? cls.join(' ') : typeof cls === 'string' ? cls : undefined;
      const key = `${keyPrefix}${i}`;
      // lowlight only ever emits <span class="hljs-*">; render everything as a span regardless
      out.push(createElement('span', { key, className }, ...toReact(el.children as RootContent[], `${key}.`)));
    }
    // comments / doctypes / raw: ignored
  }
  return out;
}

/** Highlight `code` into React elements (never HTML strings). Unknown / null language is plain text. */
export function highlightToReact(code: string, lang: string | null): ReactNode {
  const canonical = resolveLanguage(lang);
  if (!canonical || code.length > MAX_HIGHLIGHT_CHARS) return code;
  try {
    const tree = lowlight.highlight(canonical, code);
    return toReact(tree.children as RootContent[], 'h');
  } catch {
    return code;
  }
}
