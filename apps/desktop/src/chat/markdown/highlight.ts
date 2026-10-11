import { createElement, type ReactNode } from 'react';
import type { Element, RootContent } from 'hast';
import { createLowlight } from 'lowlight';
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

/** canonical name -> label shown in the code-block header */
const LABELS: Readonly<Record<string, string>> = {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  go: 'Go',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  markdown: 'Markdown',
  python: 'Python',
  rust: 'Rust',
  sql: 'SQL',
  typescript: 'TypeScript',
  xml: 'HTML',
  yaml: 'YAML',
};

const ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  python3: 'python',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  xhtml: 'xml',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  h: 'c',
  golang: 'go',
  yml: 'yaml',
  md: 'markdown',
  patch: 'diff',
  jsonc: 'json',
};

const MAX_HIGHLIGHT_CHARS = 100_000;

/** Canonical grammar name for a fence language, or null when it is unknown / plain. */
function resolveLanguage(lang: string | null): string | null {
  if (!lang) return null;
  const lc = lang.trim().toLowerCase();
  const canonical = Object.prototype.hasOwnProperty.call(ALIASES, lc) ? ALIASES[lc]! : lc;
  return Object.prototype.hasOwnProperty.call(LABELS, canonical) ? canonical : null;
}

/** Label for the code-block header, or null when the language is unknown. */
export function languageLabel(lang: string | null): string | null {
  const canonical = resolveLanguage(lang);
  return canonical ? LABELS[canonical]! : null;
}

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
