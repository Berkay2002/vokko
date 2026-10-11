// Search-term highlighting through the CSS Custom Highlight API: ranges over the rendered text, no DOM mutation and no HTML built from message
// content. `::highlight(search-hit)` in search.css paints them. Without the API (old webviews, jsdom) results simply render unhighlighted.
import { termPattern } from './query';

const NAME = 'search-hit';

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
}

const registry = (): HighlightRegistry | null => (typeof CSS === 'undefined' ? null : (CSS as unknown as { highlights?: HighlightRegistry }).highlights ?? null);
const highlightCtor = (): (new (...ranges: Range[]) => unknown) | null =>
  (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight ?? null;

export function clearHighlights(): void {
  registry()?.delete(NAME);
}

/** Highlights every whole-word occurrence of `terms` inside the `[data-search-body]` elements below `root`. */
export function paintHighlights(root: HTMLElement | null, terms: readonly string[]): void {
  const reg = registry();
  const Ctor = highlightCtor();
  if (!reg || !Ctor) return;
  const pattern = termPattern(terms);
  if (!root || !pattern) { reg.delete(NAME); return; }
  const ranges: Range[] = [];
  for (const body of root.querySelectorAll<HTMLElement>('[data-search-body]')) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue ?? '';
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        ranges.push(range);
      }
    }
  }
  if (ranges.length === 0) reg.delete(NAME);
  else reg.set(NAME, new Ctor(...ranges));
}
