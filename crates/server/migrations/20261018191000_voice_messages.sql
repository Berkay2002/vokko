-- Voice-message player data (Discord's attachment.duration_secs / waveform); NULL on every other attachment.
ALTER TABLE attachments ADD COLUMN duration_secs DOUBLE PRECISION;
ALTER TABLE attachments ADD COLUMN waveform TEXT;
