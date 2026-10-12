import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, DM_NOT_DELIVERED_TEXT, DM_REFUSED_REASON } from '../api/errors';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../api/rest', async orig => ({ ...(await orig<typeof import('../api/rest')>()), request: requestMock }));

import { openDirectMessage } from './actions';
import { useModals } from './modalStore';

describe('openDirectMessage when the DM is refused', () => {
  beforeEach(() => { requestMock.mockReset(); useModals.setState({ modal: null }); });

  it('opens the explanation dialog on 403 50007 instead of failing silently', async () => {
    requestMock.mockRejectedValue(new ApiRequestError(403, { code: 50007, message: 'Cannot send messages to this user' }));
    await expect(openDirectMessage('2')).resolves.toBeUndefined();
    expect(useModals.getState().modal).toEqual({ type: 'dmRefused' });
  });

  it('rethrows any other error and opens no dialog', async () => {
    const err = new ApiRequestError(403, { code: 50001, message: 'Missing Access' });
    requestMock.mockRejectedValue(err);
    await expect(openDirectMessage('2')).rejects.toBe(err);
    expect(useModals.getState().modal).toBeNull();
  });

  it('uses our own wording', () => {
    expect(DM_REFUSED_REASON).toBe('They only accept direct messages from friends or from people in a server they share with you.');
    expect(DM_NOT_DELIVERED_TEXT).toBe(`Message not delivered. ${DM_REFUSED_REASON}`);
  });
});