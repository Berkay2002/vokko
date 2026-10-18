-- Message components (buttons, selects) of application messages, and component clicks as interactions: a click names no command, so
-- `command_id` may be null; `target_id` holds the clicked message and `custom_id` the component.
ALTER TABLE messages ADD COLUMN components JSONB NOT NULL DEFAULT '[]';
ALTER TABLE interactions ALTER COLUMN command_id DROP NOT NULL;
ALTER TABLE interactions ADD COLUMN custom_id TEXT;
