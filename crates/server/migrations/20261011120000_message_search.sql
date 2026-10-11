-- Message search. The `simple` text search config does no stemming or stop words, so Swedish and English both work.
-- Two-argument to_tsvector is immutable, which a generated column needs; queries must use the same config.
ALTER TABLE messages ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;
CREATE INDEX messages_search_tsv ON messages USING GIN (search_tsv);
-- `from:` filter without a text query.
CREATE INDEX messages_author ON messages (author_id, id DESC);
