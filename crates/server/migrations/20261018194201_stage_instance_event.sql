-- The scheduled event that opened a stage, so completing the event ends only a stage it opened itself.
ALTER TABLE stage_instances ADD COLUMN scheduled_event_id BIGINT;
