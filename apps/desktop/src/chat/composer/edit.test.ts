import { describe, expect, it } from 'vitest';
import { applyInput, expandToAtoms, nextBoundary, prevBoundary } from './edit';

const at = (n: number) => ({ start: n, end: n });

describe('applyInput: insertion', () => {
  it('types at the caret', () => {
    expect(applyInput('ac', at(1), 'insertText', 'b')).toEqual({ value: 'abc', start: 2, end: 2, kind: 'type' });
  });

  it('replaces the selection', () => {
    expect(applyInput('hello world', { start: 0, end: 5 }, 'insertText', 'bye')).toMatchObject({ value: 'bye world', start: 3, end: 3 });
  });

  it('a typed space or newline is a break in the history', () => {
    expect(applyInput('a', at(1), 'insertText', ' ')?.kind).toBe('typeBreak');
    expect(applyInput('a', at(1), 'insertLineBreak', null)).toMatchObject({ value: 'a\n', kind: 'typeBreak' });
    expect(applyInput('a', at(1), 'insertParagraph', null)).toMatchObject({ value: 'a\n' });
  });

  it('paste and replacement text are their own history entries; CRLF is normalised', () => {
    expect(applyInput('', at(0), 'insertFromPaste', 'a\r\nb')).toEqual({ value: 'a\nb', start: 3, end: 3, kind: 'other' });
    expect(applyInput('teh', at(3), 'insertReplacementText', 'the', [], { start: 0, end: 3 })).toMatchObject({ value: 'the' });
  });

  it('an empty insertion changes nothing', () => {
    expect(applyInput('a', at(1), 'insertText', '')).toBeNull();
    expect(applyInput('a', at(1), 'insertText', null)).toBeNull();
  });

  it('formatting and history input types are not text edits', () => {
    expect(applyInput('a', { start: 0, end: 1 }, 'formatBold', null)).toBeNull();
    expect(applyInput('a', at(0), 'historyUndo', null)).toBeNull();
  });

  it('inserting inside an atom lands outside it', () => {
    expect(applyInput('a<@1>b', at(2), 'insertText', 'x', [[1, 5]])).toMatchObject({ value: 'ax<@1>b', start: 2 });
    expect(applyInput('a<@1>b', at(4), 'insertText', 'x', [[1, 5]])).toMatchObject({ value: 'a<@1>xb', start: 6 });
  });
});

describe('applyInput: deletion', () => {
  it('backspace and delete', () => {
    expect(applyInput('abc', at(2), 'deleteContentBackward', null)).toEqual({ value: 'ac', start: 1, end: 1, kind: 'delete' });
    expect(applyInput('abc', at(1), 'deleteContentForward', null)).toMatchObject({ value: 'ac', start: 1 });
    expect(applyInput('abc', at(0), 'deleteContentBackward', null)).toBeNull();
    expect(applyInput('abc', at(3), 'deleteContentForward', null)).toBeNull();
  });

  it('removes a whole grapheme', () => {
    const family = '👨‍👩‍👧';
    expect(applyInput(`a${family}`, at(1 + family.length), 'deleteContentBackward', null)?.value).toBe('a');
    expect(applyInput('a😀', at(3), 'deleteContentBackward', null)?.value).toBe('a');
  });

  it('deletes a selection regardless of the direction', () => {
    expect(applyInput('abcd', { start: 1, end: 3 }, 'deleteContentBackward', null)).toMatchObject({ value: 'ad', start: 1 });
    expect(applyInput('abcd', { start: 1, end: 3 }, 'deleteByCut', null)).toMatchObject({ value: 'ad' });
  });

  it('word deletes', () => {
    expect(applyInput('one two three', at(7), 'deleteWordBackward', null)).toMatchObject({ value: 'one  three', start: 4 });
    expect(applyInput('one two three', at(4), 'deleteWordForward', null)).toMatchObject({ value: 'one  three' });
  });

  it('word delete stops at a line break', () => {
    expect(applyInput('a\nb', at(2), 'deleteWordBackward', null)).toMatchObject({ value: 'ab', start: 1 });
  });

  it('line deletes', () => {
    expect(applyInput('ab\ncd', at(5), 'deleteSoftLineBackward', null)).toMatchObject({ value: 'ab\n', start: 3 });
    expect(applyInput('ab\ncd', at(0), 'deleteSoftLineForward', null)).toMatchObject({ value: '\ncd' });
  });

  it('removes an atom as one unit from either side', () => {
    const atoms: [number, number][] = [[1, 5]];
    expect(applyInput('a<@1>b', at(5), 'deleteContentBackward', null, atoms)).toMatchObject({ value: 'ab', start: 1 });
    expect(applyInput('a<@1>b', at(1), 'deleteContentForward', null, atoms)).toMatchObject({ value: 'ab', start: 1 });
  });

  it('a selection that ends inside an atom takes the whole atom', () => {
    expect(applyInput('a<@1>b', { start: 0, end: 3 }, 'deleteContentBackward', null, [[1, 5]])?.value).toBe('b');
  });
});

describe('boundaries', () => {
  it('expandToAtoms', () => {
    expect(expandToAtoms({ start: 2, end: 3 }, [[1, 5]])).toEqual({ start: 1, end: 5 });
    expect(expandToAtoms({ start: 0, end: 1 }, [[1, 5]])).toEqual({ start: 0, end: 1 });
  });

  it('prev/next grapheme boundaries handle surrogate pairs', () => {
    expect(prevBoundary('a😀', 3)).toBe(1);
    expect(nextBoundary('😀a', 0)).toBe(2);
    expect(prevBoundary('abc', 0)).toBe(0);
    expect(nextBoundary('abc', 3)).toBe(3);
  });
});
