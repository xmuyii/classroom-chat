require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const db = require('./db');
const migrate = require('./migrate');
const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/rooms');
const adminRoutes = require('./routes/admin');
const { attachWebSocketServer, notifyDeleted } = require('./ws');
const { startSweeper } = require('./sweeper');

const PORT = process.env.PORT || 3000;

async function main() {
  await migrate();

  const app = express();
  app.set('trust proxy', 1); // Railway sits behind a proxy; needed for secure cookies.
  app.use(express.json());

  const sessionParser = session({
    store: new pgSession({ pool: db.pool, tableName: 'user_sessions', createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  });
  app.use(sessionParser);

  app.use('/api/auth', authRoutes);
  app.use('/api/rooms', roomRoutes);
  app.use('/api/admin', adminRoutes);

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  attachWebSocketServer(server, sessionParser);

  startSweeper(notifyDeleted);

  server.listen(PORT, () => {
    console.log(`[server] listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
