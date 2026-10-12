import { describe, expect, it, vi } from 'vitest';
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
