import { describe, expect, it } from 'vitest';
import { messageHotkey, navIndex } from './messageKeys';

const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat', boolean>> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...mods });

describe('navIndex', () => {
  it('moves one row, a page, or to either end, clamped to the list', () => {
    expect(navIndex(key('ArrowUp'), 5, 10, 4)).toBe(4);
    expect(navIndex(key('ArrowDown'), 5, 10, 4)).toBe(6);
    expect(navIndex(key('ArrowDown'), 9, 10, 4)).toBe(9);
    expect(navIndex(key('ArrowUp'), 0, 10, 4)).toBe(0);
    expect(navIndex(key('PageUp'), 5, 10, 4)).toBe(1);
    expect(navIndex(key('PageDown'), 8, 10, 4)).toBe(9);
    expect(navIndex(key('Home'), 5, 10, 4)).toBe(0);
    expect(navIndex(key('End'), 5, 10, 4)).toBe(9);
  });
  it('leaves modified keys to the shell shortcuts and ignores other keys', () => {
    expect(navIndex(key('ArrowUp', { altKey: true }), 5, 10, 4)).toBeNull();
    expect(navIndex(key('PageUp', { shiftKey: true }), 5, 10, 4)).toBeNull();
    expect(navIndex(key('ArrowDown', { ctrlKey: true }), 5, 10, 4)).toBeNull();
    expect(navIndex(key('a'), 5, 10, 4)).toBeNull();
    expect(navIndex(key('ArrowUp'), 0, 0, 4)).toBeNull();
  });
});

describe('messageHotkey', () => {
  it('maps the Discord message hotkeys', () => {
    expect(messageHotkey(key('e'))).toBe('edit');
    expect(messageHotkey(key('r'))).toBe('reply');
    expect(messageHotkey(key('p'))).toBe('pin');
    expect(messageHotkey(key('+', { shiftKey: true }))).toBe('react');
    expect(messageHotkey(key('Delete'))).toBe('delete');
    expect(messageHotkey(key('Backspace', { shiftKey: true }))).toBe('delete');
    expect(messageHotkey(key('c', { metaKey: true }))).toBe('copy');
    expect(messageHotkey(key('c', { ctrlKey: true }))).toBe('copy');
  });
  it('ignores repeats, Alt, shifted letters and other keys', () => {
    expect(messageHotkey(key('e', { repeat: true }))).toBeNull();
    expect(messageHotkey(key('e', { altKey: true }))).toBeNull();
    expect(messageHotkey(key('E', { shiftKey: true }))).toBeNull();
    expect(messageHotkey(key('e', { ctrlKey: true }))).toBeNull();
    expect(messageHotkey(key('c'))).toBeNull();
    expect(messageHotkey(key('x'))).toBeNull();
  });
});
