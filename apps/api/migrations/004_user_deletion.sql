ALTER TABLE lcit.users ADD COLUMN deleted_at timestamptz;

CREATE UNIQUE INDEX users_live_username_idx ON lcit.users (username) WHERE deleted_at IS NULL;
ALTER TABLE lcit.users DROP CONSTRAINT users_username_key;
