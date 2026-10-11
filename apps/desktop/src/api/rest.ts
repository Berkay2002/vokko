import { API_ORIGIN, MOCK, REST_BASE, getToken } from "./config";
import { ApiRequestError } from "./errors";
import { mockRequest, mockUpload } from "./mock";
import type { ApiError, Attachment } from "./types";

export { ApiRequestError };

type Unauthorized = () => void;
let onUnauthorized: Unauthorized | null = null;

/** The auth module registers a handler that drops the session when any non-auth call returns 401. */
export function setUnauthorizedHandler(fn: Unauthorized | null): void {
  onUnauthorized = fn;
}

function toApiError(status: number, text: string): ApiError {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "code" in parsed && "message" in parsed) return parsed as ApiError;
  } catch {
    /* not JSON */
  }
  return { code: 0, message: text || `HTTP ${status}` };
}

function failIfUnauthorized(status: number, path: string): void {
  if (status === 401 && !path.startsWith("/auth/")) onUnauthorized?.();
}

export async function request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const token = getToken();
  if (MOCK) {
    try {
      return (await mockRequest(method, path, body, token)) as T;
    } catch (error) {
      if (error instanceof ApiRequestError) failIfUnauthorized(error.status, path);
      throw error;
    }
  }
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = token;
  let response: Response;
  try {
    response = await fetch(`${REST_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    throw new ApiRequestError(0, { code: 0, message: error instanceof Error ? error.message : "Network error" });
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!response.ok) {
    failIfUnauthorized(response.status, path);
    throw new ApiRequestError(response.status, toApiError(response.status, text));
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Resolve a server-relative attachment/avatar URL (absolute, blob: and data: URLs pass through). */
export function resolveUrl(url: string): string {
  return url.startsWith("/") ? `${API_ORIGIN}${url}` : url;
}

export function uploadAttachment(channelId: string, file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<Attachment> {
  if (MOCK) return mockUpload(channelId, file, onProgress, signal, getToken());
  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${REST_BASE}/channels/${channelId}/attachments`);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", token);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new ApiRequestError(0, { code: 0, message: "Network error" }));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        try {
          resolve(JSON.parse(xhr.responseText) as Attachment);
        } catch {
          reject(new ApiRequestError(xhr.status, { code: 0, message: "Invalid server response" }));
        }
      } else {
        failIfUnauthorized(xhr.status, "/channels");
        reject(new ApiRequestError(xhr.status, toApiError(xhr.status, xhr.responseText)));
      }
    };
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}
