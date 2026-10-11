-- Voice V1: per-channel Opus bitrate (bps) and user limit; NULL = defaults (64000, unlimited).
ALTER TABLE channels ADD COLUMN bitrate INTEGER, ADD COLUMN user_limit INTEGER;
-- Shared voice channel status ("Set channel status"), cleared when the channel empties.
ALTER TABLE channels ADD COLUMN voice_status TEXT;
