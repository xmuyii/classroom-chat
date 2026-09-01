const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware');
const { notifyRoomMembershipAdded, notifyRoomMembershipRemoved } = require('../ws');

const router = express.Router();

// List every group room with a member count, for the admin's room-management view.
router.get('/rooms', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.id, r.name, COUNT(rm.user_id)::int AS member_count
     FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id
     WHERE r.type = 'group'
     GROUP BY r.id ORDER BY r.name`
  );
  res.json({ rooms: rows });
});

// Create a new class/room.
router.post('/rooms', requireAuth, requireAdmin, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Room name is required.' });

  const { rows } = await db.query(
    "INSERT INTO rooms (name, type) VALUES ($1, 'group') RETURNING id, name",
    [name.trim().slice(0, 80)]
  );
  // Admin who created it gets auto-added, so they're never locked out of a
  // room they just made.
  await db.query(
    'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [rows[0].id, req.session.userId]
  );
  res.status(201).json({ room: rows[0] });
});

// Members of any room, regardless of the admin's own membership — this is
// the management view, distinct from the member-only /api/rooms/:id/members.
router.get('/rooms/:roomId/members', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.username FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = $1 ORDER BY u.username`,
    [req.params.roomId]
  );
  res.json({ members: rows });
});

// Add a user to a room by username.
router.post('/rooms/:roomId/members', requireAuth, requireAdmin, async (req, res) => {
  const { roomId } = req.params;
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username is required.' });

  const { rows: roomRows } = await db.query("SELECT id, name FROM rooms WHERE id = $1 AND type = 'group'", [roomId]);
  if (!roomRows.length) return res.status(404).json({ error: 'No such room.' });

  const { rows: userRows } = await db.query('SELECT id FROM users WHERE username = $1', [username]);
  if (!userRows.length) return res.status(404).json({ error: 'No such user.' });

  await db.query(
    'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [roomId, userRows[0].id]
  );

  notifyRoomMembershipAdded(userRows[0].id, roomRows[0]);

  res.status(201).json({ ok: true });
});

// Remove a user from a room.
router.delete('/rooms/:roomId/members/:username', requireAuth, requireAdmin, async (req, res) => {
  const { roomId, username } = req.params;
  const { rows: userRows } = await db.query('SELECT id FROM users WHERE username = $1', [username]);
  if (!userRows.length) return res.status(404).json({ error: 'No such user.' });

  await db.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userRows[0].id]);
  notifyRoomMembershipRemoved(userRows[0].id, roomId);

  res.json({ ok: true });
});

// Set (or clear) a room's pinned project topic/brief.
router.patch('/rooms/:roomId', requireAuth, requireAdmin, async (req, res) => {
  const { roomId } = req.params;
  const { description } = req.body || {};
  const { rows } = await db.query(
    "UPDATE rooms SET description = $1 WHERE id = $2 AND type = 'group' RETURNING id, name, description",
    [description ? description.trim().slice(0, 300) : null, roomId]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such room.' });
  res.json({ room: rows[0] });
});

module.exports = router;
