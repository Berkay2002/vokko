import { describe, expect, it } from 'vitest';
import { domToOffset, offsetToDom, readSource, walkOffset, type DomNode } from './domMap';

// A tiny structural DOM: enough for the mapping, no jsdom.
function text(data: string): DomNode {
  return { nodeType: 3, parentNode: null, childNodes: [], data };
}
function el(nodeName: string, dataset: Record<string, string>, kids: DomNode[] = []): DomNode {
  const node: DomNode = { nodeType: 1, nodeName, parentNode: null, childNodes: kids, dataset };
  for (const k of kids) k.parentNode = node;
  return node;
}
const seg = (o: number, e: number, s: string) => el('SPAN', { o: String(o), e: String(e) }, [text(s)]);
const atom = (o: number, e: number, raw: string) => el('SPAN', { o: String(o), e: String(e), atom: 'user', raw }, [text('@Alice')]);
const line = (ls: number, le: number, kids: DomNode[]) => el('DIV', { ls: String(ls), le: String(le) }, kids);
const br = () => el('BR', {});
const root = (lines: DomNode[]) => el('DIV', {}, lines);

// "**hi** <@1>x\n\nend\n"  lines: [0,10) "**hi** <@1>x"? built below by hand
//   line0: "**" "hi" "**" " " atom(<@1>) "x"   offsets 0..2, 2..4, 4..6, 6..7, 7..11, 11..12
//   line1: empty at 13
//   line2: "end" 14..17
//   line3: empty at 18 (trailing newline)
function sample() {
  const hi = text('hi');
  const l0kids = [seg(0, 2, '**'), el('SPAN', { o: '2', e: '4' }, [hi]), seg(4, 6, '**'), seg(6, 7, ' '), atom(7, 11, '<@1>'), seg(11, 12, 'x')];
  const l0 = line(0, 12, l0kids);
  const l1 = line(13, 13, [br()]);
  const l2 = line(14, 17, [seg(14, 17, 'end')]);
  const l3 = line(18, 18, [br()]);
  return { r: root([l0, l1, l2, l3]), hi, l0, l1, l2, l3, l0kids };
}

describe('domToOffset', () => {
  it('maps text positions through the segment offset', () => {
    const { r, hi } = sample();
    expect(domToOffset(r, hi, 0)).toBe(2);
    expect(domToOffset(r, hi, 1)).toBe(3);
    expect(domToOffset(r, hi, 2)).toBe(4);
  });

  it('maps line-relative positions: before a child, and past the last child', () => {
    const { r, l0, l0kids } = sample();
    expect(domToOffset(r, l0, 0)).toBe(0);
    expect(domToOffset(r, l0, 4)).toBe(7); // before the atom
    expect(domToOffset(r, l0, 5)).toBe(11); // after the atom = before "x"
    expect(domToOffset(r, l0, l0kids.length)).toBe(12);
  });

  it('a line that ends in a chip has a trailing <br>: the position before it is the end of the line', () => {
    const chip = atom(0, 4, '<@1>');
    const l = line(0, 4, [chip, br()]);
    const r = root([l]);
    expect(domToOffset(r, l, 0)).toBe(0);
    expect(domToOffset(r, l, 1)).toBe(4);
    expect(domToOffset(r, l, 2)).toBe(4);
    expect(offsetToDom(r, 4)).toEqual({ node: l, offset: 1 });
  });

  it('maps empty lines and the trailing empty line', () => {
    const { r, l1, l3 } = sample();
    expect(domToOffset(r, l1, 0)).toBe(13);
    expect(domToOffset(r, l3, 0)).toBe(18);
  });

  it('maps root-relative positions', () => {
    const { r } = sample();
    expect(domToOffset(r, r, 0)).toBe(0);
    expect(domToOffset(r, r, 2)).toBe(14);
    expect(domToOffset(r, r, 4)).toBe(18);
  });

  it('inside an atom chip: before or after, never in between', () => {
    const { r, l0kids } = sample();
    expect(domToOffset(r, l0kids[4]!, 0)).toBe(7);
    expect(domToOffset(r, l0kids[4]!, 1)).toBe(11);
    // the label text of a chip is not source text: only its edges map
    expect(domToOffset(r, l0kids[4]!.childNodes[0]!, 0)).toBe(7);
    expect(domToOffset(r, l0kids[4]!.childNodes[0]!, 3)).toBe(11);
  });
});

describe('offsetToDom', () => {
  it('lands inside text spans', () => {
    const { r, hi } = sample();
    expect(offsetToDom(r, 3)).toEqual({ node: hi, offset: 1 });
  });

  it('next to a chip: the end of the text before it, or the position after it', () => {
    const { r, l0, l0kids } = sample();
    expect(offsetToDom(r, 7)).toEqual({ node: l0kids[3]!.childNodes[0], offset: 1 });
    expect(offsetToDom(r, 11)).toEqual({ node: l0, offset: 5 });
  });

  it('empty lines, including the trailing one', () => {
    const { r, l1, l3 } = sample();
    expect(offsetToDom(r, 13)).toEqual({ node: l1, offset: 0 });
    expect(offsetToDom(r, 18)).toEqual({ node: l3, offset: 0 });
  });

  it('the end of the source', () => {
    const { r, l3 } = sample();
    expect(offsetToDom(r, 99)).toEqual({ node: l3, offset: 0 });
  });

  it('round-trips every offset of the sample outside atoms', () => {
    const { r } = sample();
    for (const o of [0, 1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 14, 15, 16, 17, 18]) {
      const p = offsetToDom(r, o);
      expect(domToOffset(r, p.node, p.offset)).toBe(o);
    }
  });

  it('an empty root', () => {
    const r = root([]);
    expect(offsetToDom(r, 0)).toEqual({ node: r, offset: 0 });
  });
});

describe('walkOffset (offsets from the text itself)', () => {
  it('ignores stale data-* after the browser edited the DOM', () => {
    const { r, hi } = sample();
    hi.data = 'hello'; // IME inserted text; data-o/e are now stale
    expect(walkOffset(r, hi, 5)).toBe(2 + 5);
    expect(readSource(r)).toBe('**hello** <@1>x\n\nend\n');
  });

  it('counts atoms by their raw length and lines by one newline', () => {
    const { r, l2 } = sample();
    expect(walkOffset(r, l2.childNodes[0]!.childNodes[0]!, 2)).toBe(12 + 1 + 0 + 1 + 2);
    expect(walkOffset(r, r, 1)).toBe(13);
  });
});

describe('readSource', () => {
  it('rebuilds the source: atoms by raw, <br> empty, lines joined by \\n', () => {
    const { r } = sample();
    expect(readSource(r)).toBe('**hi** <@1>x\n\nend\n');
  });
});
