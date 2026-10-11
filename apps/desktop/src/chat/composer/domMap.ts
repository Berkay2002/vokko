// Caret mapping between the live editor's DOM and source offsets.
//
// DOM contract (written by LiveEditor): the root's children are line elements `[data-ls][data-le]` (source offsets of the line's text);
// a line's children are segment spans `[data-o][data-e]` holding one text node, atom chips `[data-atom][data-o][data-e][data-raw]`
// (opaque: only before/after positions exist), or a lone <br> for an empty line. The interface below is structural so the mapping runs
// against plain objects in unit tests.

export interface DomNode {
  nodeType: number;
  nodeName?: string;
  parentNode: DomNode | null;
  childNodes: ArrayLike<DomNode>;
  data?: string;
  dataset?: Record<string, string | undefined>;
}

export interface DomPoint {
  node: DomNode;
  offset: number;
}

const TEXT_NODE = 3;

function num(node: DomNode | null | undefined, key: string): number | null {
  const v = node?.dataset?.[key];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const children = (node: DomNode): DomNode[] => Array.from(node.childNodes);
const isAtom = (node: DomNode) => node.dataset?.atom !== undefined;

/** Source offset of the DOM boundary point (`node`, `offset`) as reported by the Selection API. */
export function domToOffset(root: DomNode, node: DomNode, offset: number): number {
  if (node === root) {
    const lines = children(root);
    const at = lines[offset];
    if (at) return num(at, 'ls') ?? 0;
    const last = lines[lines.length - 1];
    return (last ? num(last, 'le') : null) ?? 0;
  }
  if (node.nodeType === TEXT_NODE) {
    const parent = node.parentNode;
    const o = num(parent, 'o');
    if (o !== null) {
      // the label of a chip is not source text: only its edges exist
      if (parent && isAtom(parent)) return offset <= 0 ? o : (num(parent, 'e') ?? o);
      return o + Math.max(0, Math.min(offset, node.data?.length ?? 0));
    }
  } else {
    const ls = num(node, 'ls');
    if (ls !== null) {
      const child = children(node)[offset];
      // a trailing <br> (empty line, or the line ends in a chip) has no offset of its own: it stands at the end of the line
      const at = child ? num(child, 'o') : null;
      return at ?? num(node, 'le') ?? ls;
    }
    const o = num(node, 'o');
    if (o !== null) return offset <= 0 ? o : (num(node, 'e') ?? o);
  }
  // somewhere unexpected (a node the browser made): the nearest mapped ancestor's start
  for (let n: DomNode | null = node.parentNode; n && n !== root; n = n.parentNode) {
    const ls = num(n, 'ls');
    if (ls !== null) return ls;
    const o = num(n, 'o');
    if (o !== null) return o;
  }
  return 0;
}

/** The DOM boundary point for a source offset: inside a text span when possible, else before/after an atom chip, else the empty line. */
export function offsetToDom(root: DomNode, offset: number): DomPoint {
  const lines = children(root);
  if (lines.length === 0) return { node: root, offset: 0 };
  let line = lines[lines.length - 1]!;
  for (const candidate of lines) {
    const le = num(candidate, 'le') ?? 0;
    if (offset <= le) {
      line = candidate;
      break;
    }
  }
  const kids = children(line);
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i]!;
    const o = num(kid, 'o');
    const e = num(kid, 'e');
    if (o === null || e === null) continue;
    if (isAtom(kid)) {
      if (offset <= o) return { node: line, offset: i };
      if (offset <= e) return { node: line, offset: i + 1 };
      continue;
    }
    if (offset >= o && offset <= e) {
      const text = children(kid)[0];
      if (text) return { node: text, offset: Math.min(offset - o, text.data?.length ?? offset - o) };
    }
  }
  return { node: line, offset: kids.length > 0 && kids[0]!.nodeName !== 'BR' ? kids.length : 0 };
}

/**
 * Source offset of a DOM point by counting the text before it, ignoring the `data-*` offsets. This is the one to trust right after the
 * browser edited the DOM itself (an IME composition), when the segment attributes are stale.
 */
export function walkOffset(root: DomNode, node: DomNode, offset: number): number {
  const lengthOf = (n: DomNode): number => {
    if (n.nodeType === TEXT_NODE) return n.data?.length ?? 0;
    if (isAtom(n)) return n.dataset?.raw?.length ?? 0;
    if (n.nodeName === 'BR') return 0;
    return children(n).reduce((sum, kid) => sum + lengthOf(kid), 0);
  };
  const within = (n: DomNode): number | null => {
    if (n === node) {
      if (n.nodeType === TEXT_NODE) return Math.min(offset, n.data?.length ?? 0);
      if (isAtom(n)) return offset <= 0 ? 0 : lengthOf(n);
      return children(n)
        .slice(0, offset)
        .reduce((sum, kid) => sum + lengthOf(kid), 0);
    }
    if (n.nodeType === TEXT_NODE || isAtom(n)) return null;
    let before = 0;
    for (const kid of children(n)) {
      const inside = within(kid);
      if (inside !== null) return before + inside;
      before += lengthOf(kid);
    }
    return null;
  };
  let before = 0;
  for (const line of children(root)) {
    if (node === root) return children(root).slice(0, offset).reduce((sum, kid) => sum + lengthOf(kid) + 1, 0);
    const inside = within(line);
    if (inside !== null) return before + inside;
    before += lengthOf(line) + 1;
  }
  return node === root ? before : Math.max(0, before - 1);
}

/** Rebuild the source text from the DOM (after the browser edited it during an IME composition). */
export function readSource(root: DomNode): string {
  const walk = (node: DomNode): string => {
    if (node.nodeType === TEXT_NODE) return node.data ?? '';
    if (isAtom(node)) return node.dataset?.raw ?? '';
    if (node.nodeName === 'BR') return '';
    return children(node).map(walk).join('');
  };
  return children(root)
    .map(line => (line.nodeType === TEXT_NODE ? (line.data ?? '') : walk(line)))
    .join('\n');
}
