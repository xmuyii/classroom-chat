-- Classroom chat schema
-- Run automatically on boot by server/migrate.js (idempotent).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS rooms (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('group', 'dm')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Optional pinned project brief/topic, shown at the top of a group room.
-- Added via ALTER (not the CREATE TABLE above) so it applies to databases
-- that already exist from before this column was introduced.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS description TEXT;

CREATE TABLE IF NOT EXISTS room_members (
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  room_id    UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  saved      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, id);
-- Used by the sweeper to find expired, unsaved group messages fast.
CREATE INDEX IF NOT EXISTS idx_messages_sweep ON messages(room_id, saved, created_at);

CREATE TABLE IF NOT EXISTS read_cursors (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id         UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  last_message_id BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, room_id)
);

CREATE TABLE IF NOT EXISTS admin_resets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       UUID NOT NULL REFERENCES users(id),
  target_user_id UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The one always-on group room. Created once, referenced by fixed name.
INSERT INTO rooms (name, type)
SELECT 'Class 1 group chat', 'group'
WHERE NOT EXISTS (SELECT 1 FROM rooms WHERE type = 'group');
