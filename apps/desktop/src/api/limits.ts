// Limits shared by the client and the in-memory mock. docs/api.md: uploads max 500 MiB per file (Nitro's limit, free for everyone; the
// server default and ceiling of VOKKO_MAX_UPLOAD_MB, a self-host may set it lower and then answers 413), 10 files per message, pending
// uploads per user up to 100 MiB or the per-file limit, whichever is larger.
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
