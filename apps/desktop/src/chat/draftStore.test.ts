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
  let data: Map<string, string>;
  beforeEach(() => {
    data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k),
      get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  /** A page load: fresh modules, then the session becomes ready for `userId` (drafts are per account, so none load before that). */
  const fresh = async (userId: string | null = 'u1') => {
    vi.resetModules();
    const drafts = await import('./draftStore');
    const { appStore } = await import('../api/store'); // the instance this draftStore subscribed to
    if (userId) appStore.setState({ me: { id: userId } as never });
    return { ...drafts, appStore };
  };

  it('brings text and tokens back after a reload, debounced', async () => {
    vi.useFakeTimers();
    const a = await fresh();
    a.setDraftText('c1', 'half a mess', [{ display: '@Bob', raw: '<@1>' }]);
    expect(data.get(a.draftsKey('u1'))).toBeUndefined();
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
    expect(JSON.parse(data.get(a.draftsKey('u1')) ?? '[]')).toHaveLength(50);
  });

  it('keeps each account to its own key; sign-out or an account change wipes the old one', async () => {
    const a = await fresh('u1');
    a.setDraftText('c1', 'mine');
    a.flushDrafts();
    a.appStore.setState({ me: { id: 'u2' } as never });
    expect(a.getDraft('c1').text).toBe('');
    expect(data.has(a.draftsKey('u1'))).toBe(false);
    a.setDraftText('c2', 'next');
    a.flushDrafts();
    expect(data.has(a.draftsKey('u2'))).toBe(true);
    a.appStore.setState({ me: null });
    expect(a.getDraft('c2').text).toBe('');
    expect(data.has(a.draftsKey('u2'))).toBe(false);
  });

  it('a token dropped before the user was known still wipes the saved drafts', async () => {
    const a = await fresh(null);
    data.set(a.draftsKey('u1'), JSON.stringify([['c1', 'old', []]]));
    a.appStore.setState({ token: 't' });
    a.appStore.setState({ token: null });
    expect([...data.keys()].filter(k => k.startsWith('vokko.drafts.'))).toEqual([]);
  });

  it("another tab's pagehide flush cannot write one account's drafts into the other's key", async () => {
    const tab = await fresh('u1');
    tab.setDraftText('c1', 'from A');
    data.set(tab.draftsKey('u2'), JSON.stringify([['c9', 'B draft', []]])); // the other tab is signed in as B
    tab.flushDrafts();
    expect(JSON.parse(data.get(tab.draftsKey('u2')) ?? '[]')).toEqual([['c9', 'B draft', []]]);
  });

  it('a reload with typed text is safe, but not when the saved copy would lose some', async () => {
    const a = await fresh();
    a.setDraftText('c1', 'typed');
    expect(a.hasUnsentDraft()).toBe(false);
    a.setDraftText('c2', 'x'.repeat(4001)); // the composer allows more than the 4000 saved
    expect(a.hasUnsentDraft()).toBe(true);
    a.setDraftText('c2', 'short');
    expect(a.hasUnsentDraft()).toBe(false);
    for (let i = 0; i < 51; i++) a.setDraftText(`n${i}`, 't');
    expect(a.hasUnsentDraft()).toBe(true);
  });

  it('a write that fails (quota) holds back the reload', async () => {
    const a = await fresh();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => undefined });
    a.setDraftText('c1', 'typed');
    expect(a.hasUnsentDraft()).toBe(true);
  });
});
