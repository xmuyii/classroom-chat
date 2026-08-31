const cron = require('node-cron');
const db = require('./db');

const TTL_DAYS = 9;

// Deletes expired, unsaved group messages. DMs are never touched — only
// rooms of type 'group' are in scope. Returns the deleted rows so callers
// can notify connected clients over the WebSocket.
async function sweepOnce() {
  const { rows } = await db.query(
    `DELETE FROM messages
     WHERE id IN (
       SELECT m.id FROM messages m
       JOIN rooms r ON r.id = m.room_id
       WHERE r.type = 'group'
         AND m.saved = FALSE
         AND m.created_at < now() - ($1 || ' days')::interval
     )
     RETURNING id, room_id`,
    [TTL_DAYS]
  );
  if (rows.length) {
    console.log(`[sweeper] deleted ${rows.length} expired group message(s)`);
  }
  return rows;
}

// `onDeleted(rows)` lets index.js push message_deleted events over WS.
function startSweeper(onDeleted) {
  // Hourly is plenty of precision for a 9-day window.
  cron.schedule('0 * * * *', async () => {
    try {
      const deleted = await sweepOnce();
      if (deleted.length && onDeleted) onDeleted(deleted);
    } catch (err) {
      console.error('[sweeper] failed:', err);
    }
  });
  console.log('[sweeper] scheduled hourly');
}

module.exports = { startSweeper, sweepOnce, TTL_DAYS };
