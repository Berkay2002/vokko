// Limits shared by the client and the in-memory mock. docs/api.md: uploads max 500 MiB per file (Nitro's limit, free for everyone; the
// server default and ceiling of VOKKO_MAX_UPLOAD_MB, a self-host may set it lower and then answers 413), 10 files per message, pending
// uploads per user up to 100 MiB or the per-file limit, whichever is larger.
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

let serverUploadBytes = MAX_UPLOAD_BYTES;
/** The connected server's per-file limit (READY `max_upload_bytes`); files are checked against it before they upload. */
export const maxUploadBytes = (): number => serverUploadBytes;
export function setMaxUploadBytes(bytes: number | undefined): void {
  serverUploadBytes = bytes && bytes > 0 ? Math.min(bytes, MAX_UPLOAD_BYTES) : MAX_UPLOAD_BYTES;
}
/** `95 MiB` */
export const formatUploadLimit = (bytes: number): string => `${Math.floor(bytes / (1024 * 1024))} MiB`;
