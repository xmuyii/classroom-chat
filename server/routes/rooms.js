const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware');

const router = express.Router();

async function isMember(roomId, userId) {
  const { rows } = await db.query(
    'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId]
  );
  return rows.length > 0;
}

// Room list for the sidebar:
//  - groupRooms: EVERY group room (class) in the platform, each flagged
//    isMember — so a teacher's other classes are visible by name but locked
//    until explicitly added, per the "see it, can't open it" requirement.
//  - dmRooms: only the user's own DM threads (these were never meant to be
//    globally visible, so this list stays scoped to membership as before).
router.get('/', requireAuth, async (req, res) => {
  const { rows: groupRooms } = await db.query(
    `SELECT r.id, r.name,
            EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id = r.id AND rm.user_id = $1) AS is_member
     FROM rooms r
     WHERE r.type = 'group'
     ORDER BY r.name`,
    [req.session.userId]
  );

  const { rows: dmRoomRows } = await db.query(
    `SELECT r.id FROM rooms r
     JOIN room_members rm ON rm.room_id = r.id
     WHERE rm.user_id = $1 AND r.type = 'dm'`,
    [req.session.userId]
  );

  const dmRooms = [];
  for (const room of dmRoomRows) {
    // eslint-disable-next-line no-await-in-loop
    const { rows: others } = await db.query(
      `SELECT u.username FROM room_members rm
       JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = $1 AND rm.user_id != $2`,
      [room.id, req.session.userId]
    );
    dmRooms.push({ id: room.id, name: others[0] ? others[0].username : 'Unknown' });
  }

  res.json({
    groupRooms: groupRooms.map((r) => ({ id: r.id, name: r.name, isMember: r.is_member })),
    dmRooms,
  });
});

// Find-or-create a DM room with another user.
router.post('/dm/:username', requireAuth, async (req, res) => {
  const { rows: otherRows } = await db.query('SELECT id FROM users WHERE username = $1', [req.params.username]);
  const other = otherRows[0];
  if (!other) return res.status(404).json({ error: 'No such user.' });
  if (other.id === req.session.userId) return res.status(400).json({ error: "Can't DM yourself." });

  const { rows: existing } = await db.query(
    `SELECT r.id FROM rooms r
     JOIN room_members m1 ON m1.room_id = r.id AND m1.user_id = $1
     JOIN room_members m2 ON m2.room_id = r.id AND m2.user_id = $2
     WHERE r.type = 'dm'`,
    [req.session.userId, other.id]
  );
  if (existing.length) return res.json({ roomId: existing[0].id });

  const { rows: created } = await db.query(
    "INSERT INTO rooms (name, type) VALUES ($1, 'dm') RETURNING id",
    [`DM:${req.session.username}:${req.params.username}`]
  );
  const roomId = created[0].id;
  await db.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2), ($1, $3)', [
    roomId, req.session.userId, other.id,
  ]);

  res.status(201).json({ roomId });
});

// Message history for a room, most recent first (paginated with `before`).
// Non-members get a distinguishable error code so the client can show an
// "access denied" state instead of a generic failure toast.
router.get('/:roomId/messages', requireAuth, async (req, res) => {
  const { roomId } = req.params;
  if (!(await isMember(roomId, req.session.userId))) {
    return res.status(403).json({ error: 'You do not have access to this room.', code: 'not_a_member' });
  }
  const before = req.query.before ? Number(req.query.before) : null;
  const limit = 50;

  const { rows } = await db.query(
    `SELECT m.id, m.body, m.saved, m.created_at, m.sender_id, u.username AS sender
     FROM messages m JOIN users u ON u.id = m.sender_id
     WHERE m.room_id = $1 ${before ? 'AND m.id < $3' : ''}
     ORDER BY m.id DESC LIMIT $2`,
    before ? [roomId, limit, before] : [roomId, limit]
  );

  res.json({ messages: rows.reverse() });
});

// List members of a room — only visible to members themselves, so someone
// outside a room can't see who's in it (matches "see the room exists, but
// not who's in it unless you're added").
router.get('/:roomId/members', requireAuth, async (req, res) => {
  const { roomId } = req.params;
  if (!(await isMember(roomId, req.session.userId))) {
    return res.status(403).json({ error: 'You do not have access to this room.', code: 'not_a_member' });
  }
  const { rows } = await db.query(
    `SELECT u.id, u.username FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = $1 ORDER BY u.username`,
    [roomId]
  );
  res.json({ members: rows });
});

// Toggle the "saved" flag — exempts a group message from the 9-day sweep.
router.post('/:roomId/messages/:messageId/save', requireAuth, async (req, res) => {
  const { roomId, messageId } = req.params;
  if (!(await isMember(roomId, req.session.userId))) {
    return res.status(403).json({ error: 'You do not have access to this room.', code: 'not_a_member' });
  }
  const { saved } = req.body || {};
  const { rows } = await db.query(
    'UPDATE messages SET saved = $1 WHERE id = $2 AND room_id = $3 RETURNING id, saved',
    [!!saved, messageId, roomId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Message not found.' });
  res.json({ message: rows[0] });
});

module.exports = router;
