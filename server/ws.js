const { WebSocketServer } = require('ws');
const db = require('./db');

// room_id -> Set of { ws, userId, username }
const roomSockets = new Map();

// user_id -> Set of { ws, username, myEntries } — lets admin actions push
// live updates (e.g. "you were just added to a room") to a user's open
// connection(s) without waiting for them to refresh.
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

// Called by the sweeper when it hard-deletes expired group messages, so any
// open tab removes them live instead of only noticing on next reload.
function notifyDeleted(deletedRows) {
  const byRoom = new Map();
  for (const row of deletedRows) {
    if (!byRoom.has(row.room_id)) byRoom.set(row.room_id, []);
    byRoom.get(row.room_id).push(row.id);
  }
  for (const [roomId, ids] of byRoom) {
    broadcast(roomId, { type: 'messages_deleted', roomId, ids });
  }
}

// Called by the admin "add member" route. Subscribes any currently-open
// sockets for that user to the new room's live fan-out, and tells the
// client so it can update its sidebar without a page reload.
function notifyRoomMembershipAdded(userId, room) {
  const conns = userConnections.get(userId);
  if (!conns) return; // user isn't currently connected — they'll pick it up on next login/reconnect
  for (const conn of conns) {
    const entry = { ws: conn.ws, userId, username: conn.username };
    addSocket(room.id, entry);
    conn.myEntries.set(room.id, entry);
    if (conn.ws.readyState === conn.ws.OPEN) {
      conn.ws.send(JSON.stringify({ type: 'room_added', room: { id: room.id, name: room.name, type: 'group' } }));
    }
  }
}

// Called by the admin "remove member" route. Mirror of the above.
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

    // eslint-disable-next-line no-await-in-loop
    const { rows: missed } = await db.query(
      `SELECT m.id, m.body, m.saved, m.created_at, m.sender_id, u.username AS sender
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.room_id = $1 AND m.id > $2
       ORDER BY m.id ASC LIMIT 500`,
      [roomId, since]
    );

    if (missed.length) {
      ws.send(JSON.stringify({ type: 'backlog', roomId, messages: missed }));
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
  // Pinging every 30s and terminating anything that didn't pong back forces
  // a real close event, which triggers the client's reconnect logic.
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
    const myEntries = new Map(); // roomId -> entry

    const conn = { ws, username, myEntries };
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
          const { rows } = await db.query(
            `INSERT INTO messages (room_id, sender_id, body) VALUES ($1, $2, $3)
             RETURNING id, body, saved, created_at`,
            [roomId, userId, text]
          );
          const saved = rows[0];
          const payload = {
            type: 'message',
            roomId,
            message: {
              id: saved.id,
              body: saved.body,
              saved: saved.saved,
              created_at: saved.created_at,
              sender_id: userId,
              sender: username,
            },
          };
          broadcast(roomId, payload);
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
        // Client confirms it has rendered up to a given message id — advances
        // its own cursor so a later reconnect only re-sends what's truly new.
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
};
