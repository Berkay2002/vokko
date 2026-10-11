-- Link unfurls (a JSON array of protocol Embed) and message flags (1 << 2 = SUPPRESS_EMBEDS).
ALTER TABLE messages ADD COLUMN embeds JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE messages ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
