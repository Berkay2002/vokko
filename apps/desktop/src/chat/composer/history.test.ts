import { describe, expect, it } from 'vitest';
import { EditHistory, type Snapshot } from './history';

const snap = (value: string): Snapshot => ({ value, start: value.length, end: value.length });

describe('EditHistory', () => {
  it('undo walks back and redo forward', () => {
    const h = new EditHistory();
    h.record(snap(''), snap('a'), 'other', 0);
    h.record(snap('a'), snap('ab'), 'other', 5000);
    expect(h.undo()).toEqual(snap('a'));
    expect(h.undo()).toEqual(snap(''));
    expect(h.undo()).toBeNull();
    expect(h.redo()).toEqual(snap('a'));
    expect(h.redo()).toEqual(snap('ab'));
    expect(h.redo()).toBeNull();
  });

  it('typing within a second coalesces into one step', () => {
    const h = new EditHistory();
    h.record(snap(''), snap('a'), 'type', 0);
    h.record(snap('a'), snap('ab'), 'type', 100);
    h.record(snap('ab'), snap('abc'), 'type', 200);
    expect(h.undo()).toEqual(snap(''));
    expect(h.canUndo).toBe(false);
  });

  it('a pause starts a new step', () => {
    const h = new EditHistory();
    h.record(snap(''), snap('a'), 'type', 0);
    h.record(snap('a'), snap('ab'), 'type', 2000);
    expect(h.undo()).toEqual(snap('a'));
  });

  it('a typed space closes the word: the next letter is a new step', () => {
    const h = new EditHistory();
    h.record(snap(''), snap('a'), 'type', 0);
    h.record(snap('a'), snap('a '), 'typeBreak', 10);
    h.record(snap('a '), snap('a b'), 'type', 20);
    expect(h.undo()).toEqual(snap('a '));
    expect(h.undo()).toEqual(snap(''));
  });

  it('typing and deleting are separate groups', () => {
    const h = new EditHistory();
    h.record(snap(''), snap('ab'), 'type', 0);
    h.record(snap('ab'), snap('a'), 'delete', 10);
    expect(h.undo()).toEqual(snap('ab'));
  });

  it('a new edit drops the redo stack', () => {
    const h = new EditHistory();
    h.record(snap(''), snap('a'), 'other', 0);
    h.undo();
    expect(h.canRedo).toBe(true);
    h.record(snap(''), snap('x'), 'other', 5000);
    expect(h.canRedo).toBe(false);
  });

  it('clear forgets everything', () => {
    const h = new EditHistory();
    h.record(snap(''), snap('a'), 'other', 0);
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.undo()).toBeNull();
  });

  it('is bounded', () => {
    const h = new EditHistory();
    for (let i = 0; i < 500; i++) h.record(snap(String(i)), snap(String(i + 1)), 'other', i * 5000);
    let n = 0;
    while (h.undo()) n++;
    expect(n).toBeLessThanOrEqual(200);
  });
});
