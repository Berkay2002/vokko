// Pure text edits for the live editor: what a `beforeinput` of a given type does to (value, selection). No DOM here.

export interface Selection {
  start: number;
  end: number;
}

/** How the edit groups in the undo history: consecutive `type` edits coalesce, a `typeBreak` closes the group. */
export type EditKind = 'type' | 'typeBreak' | 'delete' | 'other';

export interface EditResult {
  value: string;
  start: number;
  end: number;
  kind: EditKind;
}

export type AtomRange = readonly [number, number];

/** Move a boundary that falls inside an atom out to the atom's edge: `toEnd` picks the far edge. */
function snap(offset: number, atoms: readonly AtomRange[], toEnd: boolean): number {
  for (const [a, b] of atoms) if (offset > a && offset < b) return toEnd ? b : a;
  return offset;
}

export function expandToAtoms(sel: Selection, atoms: readonly AtomRange[]): Selection {
  if (sel.start === sel.end) {
    // a caret never lands inside a chip; if it does, move it to the nearer edge instead of replacing the chip
    for (const [a, b] of atoms) if (sel.start > a && sel.start < b) return sel.start - a <= b - sel.start ? { start: a, end: a } : { start: b, end: b };
    return sel;
  }
  return { start: snap(sel.start, atoms, false), end: snap(sel.end, atoms, true) };
}

let segmenter: Intl.Segmenter | null | undefined;
function graphemes(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    try {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

/** Start of the grapheme that ends at `i`. */
export function prevBoundary(value: string, i: number): number {
  if (i <= 0) return 0;
  const from = Math.max(0, i - 64);
  const seg = graphemes();
  if (seg) {
    let last = from;
    for (const part of seg.segment(value.slice(from, i))) last = from + part.index;
    return last;
  }
  const c = value.charCodeAt(i - 1);
  return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? i - 2 : i - 1;
}

/** End of the grapheme that starts at `i`. */
export function nextBoundary(value: string, i: number): number {
  if (i >= value.length) return value.length;
  const to = Math.min(value.length, i + 64);
  const seg = graphemes();
  if (seg) {
    const first = seg.segment(value.slice(i, to))[Symbol.iterator]().next();
    if (!first.done) return i + first.value.segment.length;
  }
  const c = value.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff && i + 1 < value.length ? i + 2 : i + 1;
}

const isSpace = (ch: string | undefined) => ch !== undefined && ch !== '\n' && /\s/.test(ch);

function wordBackward(value: string, from: number): number {
  let i = from;
  if (value[i - 1] === '\n') return i - 1;
  while (i > 0 && isSpace(value[i - 1])) i--;
  while (i > 0 && value[i - 1] !== '\n' && !/\s/.test(value[i - 1]!)) i--;
  return i;
}

function wordForward(value: string, from: number): number {
  let i = from;
  if (value[i] === '\n') return i + 1;
  while (i < value.length && isSpace(value[i])) i++;
  while (i < value.length && value[i] !== '\n' && !/\s/.test(value[i]!)) i++;
  return i;
}

function lineStart(value: string, at: number): number {
  return value.lastIndexOf('\n', at - 1) + 1;
}

function lineEnd(value: string, at: number): number {
  const i = value.indexOf('\n', at);
  return i < 0 ? value.length : i;
}

function replace(value: string, start: number, end: number, text: string, kind: EditKind): EditResult {
  const caret = start + text.length;
  return { value: value.slice(0, start) + text + value.slice(end), start: caret, end: caret, kind };
}

const INSERT_TYPES = new Set(['insertText', 'insertReplacementText', 'insertFromPaste', 'insertFromPasteAsQuotation', 'insertFromDrop', 'insertFromYank', 'insertCompositionText']);

/**
 * The effect of `inputType` on `value`. `range` is the span the browser says it will replace (spell-check replacement, drop target);
 * without it the selection is used. Returns null when the edit changes nothing (or is not a text edit: formatting, history).
 */
export function applyInput(value: string, sel: Selection, inputType: string, data: string | null, atoms: readonly AtomRange[] = [], range?: Selection): EditResult | null {
  const target = expandToAtoms(range ?? sel, atoms);
  const collapsed = target.start === target.end;

  if (INSERT_TYPES.has(inputType)) {
    const text = (data ?? '').replace(/\r\n?/g, '\n');
    if (text === '' && collapsed) return null;
    const single = text.length > 0 && [...text].length === 1;
    const kind: EditKind = inputType === 'insertText' && single ? (/\s/.test(text) ? 'typeBreak' : 'type') : 'other';
    return replace(value, target.start, target.end, text, kind);
  }
  if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') return replace(value, target.start, target.end, '\n', 'typeBreak');

  if (!inputType.startsWith('delete')) return null;
  if (!collapsed) return replace(value, target.start, target.end, '', 'delete');
  const at = target.start;
  let from = at;
  let to = at;
  switch (inputType) {
    case 'deleteContentBackward':
      from = prevBoundary(value, at);
      break;
    case 'deleteContentForward':
      to = nextBoundary(value, at);
      break;
    case 'deleteWordBackward':
      from = wordBackward(value, at);
      break;
    case 'deleteWordForward':
      to = wordForward(value, at);
      break;
    case 'deleteSoftLineBackward':
    case 'deleteHardLineBackward': {
      const start = lineStart(value, at);
      from = start < at ? start : prevBoundary(value, at);
      break;
    }
    case 'deleteSoftLineForward':
    case 'deleteHardLineForward': {
      const end = lineEnd(value, at);
      to = end > at ? end : nextBoundary(value, at);
      break;
    }
    default:
      return null;
  }
  const span = expandToAtoms({ start: from, end: to }, atoms);
  // a boundary that touches an atom takes the whole atom
  for (const [a, b] of atoms) {
    if (from < at && at === b && span.start > a) span.start = a;
    if (to > at && at === a && span.end < b) span.end = b;
  }
  if (span.start === span.end) return null;
  return replace(value, span.start, span.end, '', 'delete');
}

/** Wrap the selection in a markdown `marker` (`**`, `||`, ...), or unwrap it when the marker already surrounds it. The selection stays on the same text. */
export function toggleWrap(value: string, sel: Selection, marker: string): Selection & { value: string } {
  const m = marker.length;
  if (sel.start >= m && value.slice(sel.start - m, sel.start) === marker && value.slice(sel.end, sel.end + m) === marker) {
    return { value: value.slice(0, sel.start - m) + value.slice(sel.start, sel.end) + value.slice(sel.end + m), start: sel.start - m, end: sel.end - m };
  }
  return { value: value.slice(0, sel.start) + marker + value.slice(sel.start, sel.end) + marker + value.slice(sel.end), start: sel.start + m, end: sel.end + m };
}
