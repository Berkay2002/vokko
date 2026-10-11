-- Unguessable download key (32 hex chars). Rows without a key (data from before this migration) are never served.
ALTER TABLE attachments ADD COLUMN key TEXT;

-- Set when an upload is claimed as an avatar or icon. Those rows keep message_id NULL forever, so message_id alone
-- cannot tell "pending upload" from "in use"; the cleanup task only deletes rows with message_id IS NULL AND claimed_at IS NULL.
ALTER TABLE attachments ADD COLUMN claimed_at TIMESTAMPTZ;

-- Old avatar/icon rows are referenced by path prefix `<id>/`; mark them claimed so cleanup never touches them.
UPDATE attachments SET claimed_at = now()
WHERE message_id IS NULL AND (
    id::text IN (SELECT split_part(avatar_path, '/', 1) FROM users WHERE avatar_path IS NOT NULL)
    OR id::text IN (SELECT split_part(icon_path, '/', 1) FROM guilds WHERE icon_path IS NOT NULL)
    OR id::text IN (SELECT split_part(icon_path, '/', 1) FROM channels WHERE icon_path IS NOT NULL)
);

CREATE INDEX attachments_pending ON attachments (created_at) WHERE message_id IS NULL AND claimed_at IS NULL;
