-- Alt text of an attachment (set when the message is sent, up to 1024 characters).
ALTER TABLE attachments ADD COLUMN description TEXT;
