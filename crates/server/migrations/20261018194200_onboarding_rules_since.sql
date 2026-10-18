-- When a guild's rules screen appeared (set when the rules go from none to some). Only members who joined after it have to accept the
-- rules before they can talk, so turning rules on never locks out someone who joined before them. Rows that already have rules start now.
ALTER TABLE guild_onboarding ADD COLUMN rules_since TIMESTAMPTZ;
UPDATE guild_onboarding SET rules_since = now() WHERE rules IS NOT NULL;
