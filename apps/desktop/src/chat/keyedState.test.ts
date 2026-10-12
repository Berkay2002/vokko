import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterNextKey, readKeyed, writeKeyed, type KeyToken } from './keyedState';

describe('keyed state', () => {
  // useKeyToken makes a fresh object per key occurrence: A, then B, then A again are three tokens
  const tokens = () => ({ a1: {} as KeyToken, b: {} as KeyToken, a2: {} as KeyToken });

  it('reads the initial value until set, and again after the key changes', () => {
    const t = tokens();
    expect(readKeyed(null, t.a1, 0)).toBe(0);
    const s = writeKeyed(null, t.a1, 0, 3);
    expect(readKeyed(s, t.a1, 0)).toBe(3);
    expect(readKeyed(s, t.b, 0)).toBe(0);
  });

  it('a key that comes back (A, then B, then A) starts from the initial value', () => {
    const t = tokens();
    // a /nick error set on draft "a", then "ab", then Backspace back to "a": the error must not return
    const s = writeKeyed<string | null>(null, t.a1, null, 'Nicknames only exist in servers.');
    expect(readKeyed(s, t.b, null)).toBeNull();
    expect(readKeyed(s, t.a2, null)).toBeNull();
    // the highlight goes back to row 0, not to the row picked under the earlier occurrence
    const sel = writeKeyed(null, t.a1, 0, 4);
    expect(readKeyed(sel, t.a2, 0)).toBe(0);
    expect(writeKeyed(sel, t.a2, 0, (n: number) => n + 1).value).toBe(1);
  });

  it('an updater sees the value for the current token', () => {
    const t = tokens();
    const s = writeKeyed(null, t.a1, 0, 4);
    expect(writeKeyed(s, t.a1, 0, (n: number) => n + 1)).toEqual({ token: t.a1, value: 5 });
    expect(writeKeyed(s, t.b, 0, (n: number) => n + 1)).toEqual({ token: t.b, value: 1 });
  });
});

describe('afterNextKey', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('targets the token that replaced the submitted one', () => {
    const submitted: KeyToken = {}, cleared: KeyToken = {};
    submitted.next = cleared;
    const apply = vi.fn();
    afterNextKey(submitted, apply);
    expect(apply).toHaveBeenCalledWith(cleared);
  });

  it('waits one task for the clearing to commit (the result settled first), and drops the result if it never does', () => {
    vi.useFakeTimers();
    const submitted: KeyToken = {}, cleared: KeyToken = {};
    const apply = vi.fn();
    afterNextKey(submitted, apply);
    expect(apply).not.toHaveBeenCalled();
    submitted.next = cleared;
    vi.runAllTimers();
    expect(apply).toHaveBeenCalledWith(cleared);

    const lone: KeyToken = {};
    const never = vi.fn();
    afterNextKey(lone, never);
    vi.runAllTimers();
    expect(never).not.toHaveBeenCalled();
  });
});

// Typing a long draft logged "Maximum update depth exceeded" (stack: draftStore emit -> forceStoreRerender): the composer reset state
// from effects keyed on the draft text (`useEffect(() => setError(null), [text])`, `useEffect(() => setSelected(0), [triggerKey])`),
// so every keystroke queued an update from a passive effect and React's nested passive update counter kept climbing past its limit.
// These files run on every keystroke: they must not reset state from an effect keyed on the text or the autocomplete key.
describe('composer keystroke path', () => {
  const files = ['./Composer.tsx', '../apps/CommandComposer.tsx', './composer/ComposerInput.tsx', './composer/LiveEditor.tsx'];
  const resetEffect = /useEffect\(\s*\(\)\s*=>\s*\{?\s*set[A-Z]\w*\([^)]*\);?\s*\}?\s*,\s*\[[^\]]*\b(text|value|triggerKey|listKey)\b[^\]]*\]\s*\)/;
  for (const file of files) {
    it(`${file} has no setState-only effect keyed on the draft`, () => {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(src).not.toMatch(resetEffect);
    });
  }

  it('the pattern catches the original reset effects', () => {
    expect('useEffect(() => setError(null), [text]);').toMatch(resetEffect);
    expect('useEffect(() => { setSelected(0); }, [triggerKey]);').toMatch(resetEffect);
    expect('useEffect(() => setSelected(0), [listKey]);').toMatch(resetEffect);
  });
});
