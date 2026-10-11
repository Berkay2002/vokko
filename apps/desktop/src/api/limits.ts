// Limits shared by the client and the in-memory mock. docs/api.md: uploads max 25 MiB per file (server default, VOKKO_MAX_UPLOAD_MB),
// 10 files per message, 100 MiB of pending uploads per user.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
