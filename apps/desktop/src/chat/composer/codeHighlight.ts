// Syntax highlighting of a fenced code block's body as offset ranges, built from the message renderer's highlighter
// (so the composer and the sent message use the same languages and classes).
import { isValidElement, type ReactNode } from 'react';
import { highlightToReact } from '../markdown';
import type { HighlightRange } from './tokenize';

export function highlightRanges(code: string, lang: string | null): HighlightRange[] {
  const out: HighlightRange[] = [];
  let pos = 0;
  const walk = (node: ReactNode, cls: string | null): void => {
    if (typeof node === 'string') {
      if (cls && node.length > 0) out.push({ start: pos, end: pos + node.length, cls });
      pos += node.length;
    } else if (Array.isArray(node)) {
      for (const child of node) walk(child as ReactNode, cls);
    } else if (isValidElement(node)) {
      const props = node.props as { className?: string; children?: ReactNode };
      walk(props.children, props.className ?? cls);
    }
  };
  walk(highlightToReact(code, lang), null);
  return pos === code.length ? out : [];
}
