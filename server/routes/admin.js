const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware');
const {
  notifyRoomMembershipAdded,
  notifyRoomMembershipRemoved,
  notifyUser,
  broadcastNewMessage,
  broadcastMessagesDeleted,
} = require('../ws');

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

// --- Moderation ---------------------------------------------------------

// Messages the word filter held before anyone but the sender saw them.
router.get('/moderation/pending', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.id, m.body, m.created_at, r.id AS room_id, r.name AS room_name, u.username AS sender
     FROM messages m
     JOIN rooms r ON r.id = m.room_id
     JOIN users u ON u.id = m.sender_id
     WHERE m.status = 'pending'
     ORDER BY m.id ASC`
  );
  res.json({ items: rows });
});

// Let it through — becomes visible to the room, same as any normal message.
router.post('/moderation/:messageId/approve', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await db.query(
    `UPDATE messages SET status = 'visible'
     WHERE id = $1 AND status = 'pending'
     RETURNING id, room_id, body, saved, flagged, created_at, sender_id`,
    [req.params.messageId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found, or already resolved.' });
  const m = rows[0];
  const { rows: userRows } = await db.query('SELECT username FROM users WHERE id = $1', [m.sender_id]);
  broadcastNewMessage(m.room_id, {
    id: m.id, body: m.body, saved: m.saved, flagged: m.flagged, created_at: m.created_at,
    sender_id: m.sender_id, sender: userRows[0] ? userRows[0].username : 'Unknown',
  });
  res.json({ ok: true });
});

// Discard it — nobody but the sender ever saw it, and their own copy is removed too.
router.post('/moderation/:messageId/reject', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await db.query(
    "DELETE FROM messages WHERE id = $1 AND status = 'pending' RETURNING id, room_id, sender_id",
    [req.params.messageId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found, or already resolved.' });
  const m = rows[0];
  notifyUser(m.sender_id, { type: 'messages_deleted', roomId: m.room_id, ids: [m.id] });
  res.json({ ok: true });
});

// Messages students have flagged — already visible, awaiting a decision.
router.get('/moderation/flagged', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.id, m.body, m.created_at, r.id AS room_id, r.name AS room_name, u.username AS sender
     FROM messages m
     JOIN rooms r ON r.id = m.room_id
     JOIN users u ON u.id = m.sender_id
     WHERE m.flagged = TRUE AND m.status = 'visible'
     ORDER BY m.id DESC LIMIT 50`
  );
  res.json({ items: rows });
});

// Clears a flag without deleting the message.
router.post('/moderation/:messageId/dismiss-flag', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await db.query(
    'UPDATE messages SET flagged = FALSE WHERE id = $1 RETURNING id',
    [req.params.messageId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

// Instant delete for any message — used both from the in-chat delete button
// and from the flagged-queue "Delete" action. Removes it for everyone live.
router.delete('/messages/:messageId', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await db.query(
    'DELETE FROM messages WHERE id = $1 RETURNING id, room_id',
    [req.params.messageId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Message not found.' });
  broadcastMessagesDeleted(rows[0].room_id, [rows[0].id]);
  res.json({ ok: true });
});

module.exports = router;
