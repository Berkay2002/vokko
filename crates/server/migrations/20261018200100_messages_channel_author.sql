-- "Has this user written in this DM" (events::DM_TAKEN_PART, presence::hidden_pairs) runs on every presence update, READY and
-- typing call; without this a flood of messages in a DM makes each lookup a scan.
CREATE INDEX messages_channel_author ON messages (channel_id, author_id);
