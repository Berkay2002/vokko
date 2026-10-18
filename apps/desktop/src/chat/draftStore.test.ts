import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, getDraft, setDraftText, subscribeDraft } from './draftStore';

describe('draft store', () => {
  it('notifies only the edited channel and keeps the snapshot stable between edits', () => {
    const a = vi.fn(), b = vi.fn();
    const offA = subscribeDraft('a', a), offB = subscribeDraft('b', b);
    setDraftText('a', 'hello');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    // useSyncExternalStore re-renders forever if getSnapshot returns a new object on every call
    expect(getDraft('a')).toBe(getDraft('a'));
    expect(getDraft('b')).toBe(getDraft('b'));
    clearDraft('a');
    expect(getDraft('a').text).toBe('');
    offA(); offB();
  });

  it('a listener is gone after unsubscribing', () => {
    const l = vi.fn();
    const off = subscribeDraft('c', l);
    off();
    setDraftText('c', 'x');
    expect(l).not.toHaveBeenCalled();
    clearDraft('c');
  });
});

describe('draft persistence', () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const fresh = async () => { vi.resetModules(); return import('./draftStore'); };

  it('brings text and tokens back after a reload, debounced', async () => {
    vi.useFakeTimers();
    const a = await fresh();
    a.setDraftText('c1', 'half a mess', [{ display: '@Bob', raw: '<@1>' }]);
    expect(localStorage.getItem(a.DRAFTS_KEY)).toBeNull();
    vi.advanceTimersByTime(600);
    const b = await fresh();
    expect(b.getDraft('c1').text).toBe('half a mess');
    expect(b.getDraft('c1').tokens).toEqual([{ display: '@Bob', raw: '<@1>' }]);
    expect(b.getDraft('c1').uploads).toEqual([]);
  });

  it('a sent draft is gone at once, even inside the debounce', async () => {
    vi.useFakeTimers();
    const a = await fresh();
    a.setDraftText('c1', 'sent');
    a.flushDrafts();
    a.clearDraft('c1');
    expect((await fresh()).getDraft('c1').text).toBe('');
  });

  it('caps text at 4000 chars and keeps the 50 most recent channels', async () => {
    const a = await fresh();
    for (let i = 0; i < 55; i++) a.setDraftText(`c${i}`, i === 54 ? 'x'.repeat(5000) : `t${i}`);
    a.setDraftText('c10', 'touched'); // moves to the newest slot
    a.flushDrafts();
    const b = await fresh();
    expect(b.getDraft('c0').text).toBe('');
    expect(b.getDraft('c5').text).toBe('t5');
    expect(b.getDraft('c10').text).toBe('touched');
    expect(b.getDraft('c54').text).toHaveLength(4000);
    expect(JSON.parse(localStorage.getItem(a.DRAFTS_KEY) ?? '[]')).toHaveLength(50);
  });

  it('only uploads count as unsent once text is persisted', async () => {
    const a = await fresh();
    a.setDraftText('c1', 'typed');
    expect(a.hasUnsentDraft()).toBe(false);
  });
});
