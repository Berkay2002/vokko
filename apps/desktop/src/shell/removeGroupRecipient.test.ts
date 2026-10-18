import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => vi.fn());
vi.mock('../api/rest', async orig => ({ ...(await orig<typeof import('../api/rest')>()), request: requestMock }));
vi.mock('../chat/toast', () => ({ chatToast: toastMock }));

import { ApiRequestError } from '../api/errors';
import { removeGroupRecipient } from './actions';

describe('removeGroupRecipient', () => {
  beforeEach(() => { requestMock.mockReset(); toastMock.mockReset(); });

  it('removes quietly when the server accepts', async () => {
    requestMock.mockResolvedValue(undefined);
    await removeGroupRecipient('10', '20');
    expect(requestMock).toHaveBeenCalledWith('DELETE', '/channels/10/recipients/20');
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('toasts instead of failing silently', async () => {
    requestMock.mockRejectedValue(new Error('offline'));
    await removeGroupRecipient('10', '20');
    expect(toastMock).toHaveBeenCalledWith("Couldn't remove them from the group. Try again.");
  });

  it('says so when the caller is not allowed', async () => {
    requestMock.mockRejectedValue(new ApiRequestError(403, { code: 50013, message: 'Missing Permissions' }));
    await removeGroupRecipient('10', '20');
    expect(toastMock).toHaveBeenCalledWith("You don't have permission to remove that person.");
  });
});
