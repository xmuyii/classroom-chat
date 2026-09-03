const { WebSocketServer } = require('ws');
const db = require('./db');
const { containsBlockedWord } = require('./moderation');

// room_id -> Set of { ws, userId, username }
const roomSockets = new Map();

// user_id -> Set of { ws, username, isAdmin, myEntries } — lets admin
// actions and moderation events push live updates to a user's open
// connection(s) directly, without waiting for them to refresh.
const userConnections = new Map();

function addSocket(roomId, entry) {
  if (!roomSockets.has(roomId)) roomSockets.set(roomId, new Set());
  roomSockets.get(roomId).add(entry);
}

function removeSocket(roomId, entry) {
  const set = roomSockets.get(roomId);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) roomSockets.delete(roomId);
}

function broadcast(roomId, payload, exceptWs) {
  const set = roomSockets.get(roomId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const { ws } of set) {
    if (ws !== exceptWs && ws.readyState === ws.OPEN) ws.send(data);
  }
}

// Whether a user currently has at least one open WebSocket connection.
function isOnline(userId) {
  const conns = userConnections.get(userId);
  return !!conns && conns.size > 0;
}

// Sends a payload to every currently-open socket for one specific user
// (e.g. telling a student their held message was rejected).
function notifyUser(userId, payload) {
  const conns = userConnections.get(userId);
  if (!conns) return;
  const data = JSON.stringify(payload);
  for (const conn of conns) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(data);
  }
}

// Sends a payload to every currently-connected admin (e.g. "a message needs review").
function notifyAdmins(payload) {
  const data = JSON.stringify(payload);
  for (const conns of userConnections.values()) {
    for (const conn of conns) {
      if (conn.isAdmin && conn.ws.readyState === conn.ws.OPEN) conn.ws.send(data);
    }
  }
}

// Broadcasts a newly-visible message to a room (used for normal sends and
// for messages an admin approves out of the moderation queue).
function broadcastNewMessage(roomId, message) {
  broadcast(roomId, { type: 'message', roomId, message });
}

// Broadcasts that one or more messages should be removed from view —
// used by the sweeper, admin instant-delete, and rejected-message cleanup.
function broadcastMessagesDeleted(roomId, ids) {
  broadcast(roomId, { type: 'messages_deleted', roomId, ids });
}

// Called by the sweeper when it hard-deletes expired group messages.
function notifyDeleted(deletedRows) {
  const byRoom = new Map();
  for (const row of deletedRows) {
    if (!byRoom.has(row.room_id)) byRoom.set(row.room_id, []);
    byRoom.get(row.room_id).push(row.id);
  }
  for (const [roomId, ids] of byRoom) broadcastMessagesDeleted(roomId, ids);
}

// Called by the admin "add member" route.
function notifyRoomMembershipAdded(userId, room) {
  const conns = userConnections.get(userId);
  if (!conns) return;
  for (const conn of conns) {
    const entry = { ws: conn.ws, userId, username: conn.username };
    addSocket(room.id, entry);
    conn.myEntries.set(room.id, entry);
    if (conn.ws.readyState === conn.ws.OPEN) {
      conn.ws.send(JSON.stringify({ type: 'room_added', room: { id: room.id, name: room.name, type: 'group' } }));
    }
  }
}

// Called by the admin "remove member" route.
function notifyRoomMembershipRemoved(userId, roomId) {
  const conns = userConnections.get(userId);
  if (!conns) return;
  for (const conn of conns) {
    const entry = conn.myEntries.get(roomId);
    if (entry) {
      removeSocket(roomId, entry);
      conn.myEntries.delete(roomId);
    }
    if (conn.ws.readyState === conn.ws.OPEN) {
      conn.ws.send(JSON.stringify({ type: 'room_removed', roomId }));
    }
  }
}

async function getUserRooms(userId) {
  const { rows } = await db.query('SELECT room_id FROM room_members WHERE user_id = $1', [userId]);
  return rows.map((r) => r.room_id);
}

async function sendCatchUp(ws, userId, roomIds) {
  for (const roomId of roomIds) {
    // eslint-disable-next-line no-await-in-loop
    const { rows: cursorRows } = await db.query(
      'SELECT last_message_id FROM read_cursors WHERE user_id = $1 AND room_id = $2',
      [userId, roomId]
    );
    const since = cursorRows[0] ? cursorRows[0].last_message_id : 0;

    // A user's own held-for-review messages are included in their own
    // catch-up (so they still see their pending message after reconnecting);
    // everyone else's catch-up only ever includes 'visible' messages.
    // eslint-disable-next-line no-await-in-loop
    const { rows: missed } = await db.query(
      `SELECT m.id, m.body, m.saved, m.flagged, m.status, m.created_at, m.sender_id, u.username AS sender
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.room_id = $1 AND m.id > $2
         AND (m.status = 'visible' OR (m.status = 'pending' AND m.sender_id = $3))
       ORDER BY m.id ASC LIMIT 500`,
      [roomId, since, userId]
    );

    if (missed.length) {
      const messages = missed.map((m) => ({ ...m, pending: m.status === 'pending' }));
      ws.send(JSON.stringify({ type: 'backlog', roomId, messages }));
      const maxId = missed[missed.length - 1].id;
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        `INSERT INTO read_cursors (user_id, room_id, last_message_id) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, room_id) DO UPDATE SET last_message_id = EXCLUDED.last_message_id`,
        [userId, roomId, maxId]
      );
    }
  }
}

function attachWebSocketServer(server, sessionParser) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    sessionParser(req, {}, () => {
      if (!req.session || !req.session.userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  });

  // Heartbeat: proxies (Railway's included) silently drop idle WebSocket
  // connections without sending either side a close frame. Without this,
  // readyState stays OPEN on a dead socket forever and sends just vanish.
  const HEARTBEAT_MS = 30000;
  wss.on('connection', (ws) => {
    ws.isAlive = true;
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', async (ws, req) => {
    ws.on('pong', () => { ws.isAlive = true; });
    const userId = req.session.userId;
    const username = req.session.username;
    const isAdmin = !!req.session.isAdmin;
    const myEntries = new Map(); // roomId -> entry

    const conn = { ws, username, isAdmin, myEntries };
    if (!userConnections.has(userId)) userConnections.set(userId, new Set());
    userConnections.get(userId).add(conn);

    let roomIds;
    try {
      roomIds = await getUserRooms(userId);
      for (const roomId of roomIds) {
        const entry = { ws, userId, username };
        addSocket(roomId, entry);
        myEntries.set(roomId, entry);
      }
      await sendCatchUp(ws, userId, roomIds);
    } catch (err) {
      console.error('[ws] connection setup failed:', err);
      ws.close();
      return;
    }

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'chat') {
        const { roomId, body } = msg;
        if (!roomId || !body || !body.trim() || !myEntries.has(roomId)) return;
        const text = body.trim().slice(0, 4000);
        try {
          const blocked = containsBlockedWord(text);
          const status = blocked ? 'pending' : 'visible';
          const { rows } = await db.query(
            `INSERT INTO messages (room_id, sender_id, body, status) VALUES ($1, $2, $3, $4)
             RETURNING id, body, saved, created_at`,
            [roomId, userId, text, status]
          );
          const saved = rows[0];
          const messagePayload = {
            id: saved.id,
            body: saved.body,
            saved: saved.saved,
            created_at: saved.created_at,
            sender_id: userId,
            sender: username,
            flagged: false,
          };

          if (blocked) {
            // Held for review — only the sender sees their own copy, marked
            // pending, until an admin approves or rejects it.
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'message', roomId, message: { ...messagePayload, pending: true } }));
            }
            const { rows: roomRows } = await db.query('SELECT name FROM rooms WHERE id = $1', [roomId]);
            notifyAdmins({
              type: 'moderation_alert',
              reason: 'pending',
              roomId,
              roomName: roomRows[0] ? roomRows[0].name : '',
              sender: username,
            });
          } else {
            broadcastNewMessage(roomId, messagePayload);
          }

          // The sender's own cursor advances either way — they've "read"
          // their own message the moment they sent it.
          await db.query(
            `INSERT INTO read_cursors (user_id, room_id, last_message_id) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, room_id) DO UPDATE SET last_message_id = GREATEST(read_cursors.last_message_id, EXCLUDED.last_message_id)`,
            [userId, roomId, saved.id]
          );
        } catch (err) {
          console.error('[ws] send failed:', err);
        }
      } else if (msg.type === 'typing') {
        const { roomId } = msg;
        if (!roomId || !myEntries.has(roomId)) return;
        broadcast(roomId, { type: 'typing', roomId, username }, ws);
      } else if (msg.type === 'ack') {
        const { roomId, messageId } = msg;
        if (!roomId || !messageId || !myEntries.has(roomId)) return;
        db.query(
          `INSERT INTO read_cursors (user_id, room_id, last_message_id) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, room_id) DO UPDATE SET last_message_id = GREATEST(read_cursors.last_message_id, EXCLUDED.last_message_id)`,
          [userId, roomId, messageId]
        ).catch((err) => console.error('[ws] ack failed:', err));
      }
    });

    ws.on('close', () => {
      for (const [roomId, entry] of myEntries) removeSocket(roomId, entry);
      const conns = userConnections.get(userId);
      if (conns) {
        conns.delete(conn);
        if (conns.size === 0) userConnections.delete(userId);
      }
    });
  });
}

module.exports = {
  attachWebSocketServer,
  notifyDeleted,
  notifyRoomMembershipAdded,
  notifyRoomMembershipRemoved,
  notifyUser,
  notifyAdmins,
  broadcastNewMessage,
  broadcastMessagesDeleted,
  isOnline,
};
