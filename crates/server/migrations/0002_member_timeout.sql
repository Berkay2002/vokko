-- Communication timeout: while in the future the member keeps only VIEW_CHANNEL | READ_MESSAGE_HISTORY.
ALTER TABLE guild_members ADD COLUMN timeout_until TIMESTAMPTZ;
