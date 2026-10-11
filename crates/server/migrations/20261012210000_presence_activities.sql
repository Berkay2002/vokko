-- What a user is doing (a detected game): a JSON array of activities, at most one. Empty while nobody is connected.
ALTER TABLE presences ADD COLUMN activities TEXT NOT NULL DEFAULT '[]';
