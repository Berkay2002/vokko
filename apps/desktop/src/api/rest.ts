// STUB (vokko-chat): routes straight into the in-memory mock. Dropped at milestone A merge.
import type { ApiError, Attachment } from './types';
import { handle, upload } from './mock';

export class ApiRequestError extends Error {
  constructor(public status: number, public body: ApiError) { super(body.message); }
}

export async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  await new Promise(r => setTimeout(r, 40));
  return handle(method, path, body) as T;
}

export async function uploadAttachment(channelId: string, file: File, onProgress?: (fraction: number) => void): Promise<Attachment> {
  for (const f of [0.2, 0.5, 0.8]) { onProgress?.(f); await new Promise(r => setTimeout(r, 120)); }
  const a = await upload(channelId, file);
  onProgress?.(1);
  return a;
}
