import { describe, expect, it } from 'vitest';
import { enterConfirms, pinConfirmCopy, pinTargetLabel } from './PinConfirmDialog';

const key = (over: Partial<Parameters<typeof enterConfirms>[0]> = {}) => ({
  key: 'Enter', repeat: false, defaultPrevented: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: null, ...over,
});

describe('pin confirmation copy', () => {
  it('pin: Discord title, body naming the channel, primary confirm', () => {
    const c = pinConfirmCopy('pin', '#general');
    expect(c.title).toBe('Pin this message?');
    expect(c.body).toBe('This will pin the message to #general so everyone can find it later.');
    expect([c.cancel, c.confirm, c.danger]).toEqual(['Cancel', 'Pin it', false]);
  });

  it('unpin: matching modal with a danger confirm', () => {
    const c = pinConfirmCopy('unpin', '#general');
    expect(c.title).toBe('Unpin message?');
    expect(c.body).toBe('Remove this message from the pinned list?');
    expect([c.cancel, c.confirm, c.danger]).toEqual(['Cancel', 'Unpin', true]);
  });

  it('names a server channel with # and a DM by its recipients', () => {
    expect(pinTargetLabel({ name: 'general', guild_id: '1', recipients: undefined })).toBe('#general');
    expect(pinTargetLabel({ name: null, guild_id: null, recipients: [{ id: '2', username: 'alice', global_name: null } as never] })).toBe('alice');
    expect(pinTargetLabel(undefined)).toBe('this conversation');
  });
});

describe('Enter in the pin dialog', () => {
  it('confirms from the dialog body but leaves a focused button to its own click', () => {
    expect(enterConfirms(key())).toBe(true);
    expect(enterConfirms(key({ target: { closest: () => ({}) } as never }))).toBe(false);
    expect(enterConfirms(key({ target: { closest: () => null } as never }))).toBe(true);
  });

  it('ignores other keys, key repeat and modified Enter', () => {
    expect(enterConfirms(key({ key: 'a' }))).toBe(false);
    expect(enterConfirms(key({ repeat: true }))).toBe(false);
    expect(enterConfirms(key({ shiftKey: true }))).toBe(false);
    expect(enterConfirms(key({ defaultPrevented: true }))).toBe(false);
  });
});
