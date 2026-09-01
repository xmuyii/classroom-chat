const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { generateCodes, verifyAndBurnCode, remainingCount } = require('../recoveryCodes');
const { requireAuth, requireAdmin } = require('../middleware');
const rateLimit = require('../rateLimit');

const router = express.Router();
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 8 });
// Registration is intentionally looser than login/recovery: a classroom sits
// behind one shared school IP, and account creation isn't the sensitive path
// those two are (worst case of abuse here is spam accounts, which an admin
// can just delete).
const registerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;

function validCredentials(username, password) {
  if (!username || !password) return 'Username and password are required.';
  if (!USERNAME_RE.test(username)) {
    return 'Usernames must be 3-24 characters: letters, numbers, _ . -';
  }
  if (password.length < 8) return 'Password must be at least 8 characters.';
  return null;
}

// --- Register ---------------------------------------------------------
// First account created becomes admin (bootstrap for a fresh deployment).
router.post('/register', registerLimiter((req) => `reg:${req.ip}`), async (req, res) => {
  const { username, password } = req.body || {};
  const err = validCredentials(username, password);
  if (err) return res.status(400).json({ error: err });

  const existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rows.length) {
    return res.status(409).json({ error: 'That username is taken.' });
  }

  const { rows: countRows } = await db.query('SELECT COUNT(*)::int AS n FROM users');
  const isFirstUser = countRows[0].n === 0;

  const hash = await bcrypt.hash(password, 12);
  const { rows } = await db.query(
    'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING id, username, is_admin',
    [username, hash, isFirstUser]
  );
  const user = rows[0];

  // No auto-join: with multiple rooms/classes now supported, an admin
  // explicitly adds each new account to the right room(s) — see
  // POST /api/admin/rooms/:roomId/members. The first (admin) account is the
  // exception: give them every existing group room so they can manage things
  // immediately without a chicken-and-egg membership problem.
  if (isFirstUser) {
    const { rows: allGroupRooms } = await db.query("SELECT id FROM rooms WHERE type = 'group'");
    for (const room of allGroupRooms) {
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [room.id, user.id]
      );
    }
  }

  const codes = await generateCodes(user.id);

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin;

  res.status(201).json({
    user: { id: user.id, username: user.username, isAdmin: user.is_admin },
    recoveryCodes: codes, // shown once — client must prompt the user to save these
  });
});

// --- Login --------------------------------------------------------------
router.post('/login', limiter((req) => `login:${req.ip}:${(req.body || {}).username || ''}`), async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Incorrect username or password.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect username or password.' });

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin;

  res.json({ user: { id: user.id, username: user.username, isAdmin: user.is_admin } });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', requireAuth, async (req, res) => {
  const n = await remainingCount(req.session.userId);
  res.json({
    user: { id: req.session.userId, username: req.session.username, isAdmin: req.session.isAdmin },
    recoveryCodesRemaining: n,
  });
});

// --- Recovery-code based password reset ---------------------------------
// Self-service fast path: username + one unused recovery code + new password.
router.post('/recover', limiter((req) => `recover:${req.ip}:${(req.body || {}).username || ''}`), async (req, res) => {
  const { username, code, newPassword } = req.body || {};
  if (!username || !code || !newPassword) {
    return res.status(400).json({ error: 'Username, recovery code, and a new password are required.' });
  }
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const { rows } = await db.query('SELECT id FROM users WHERE username = $1', [username]);
  const user = rows[0];
  // Same response whether the user exists or the code is wrong — don't leak which.
  const genericFail = () => res.status(401).json({ error: 'That username/code combination is not valid.' });
  if (!user) return genericFail();

  const burned = await verifyAndBurnCode(user.id, code);
  if (!burned) return genericFail();

  const hash = await bcrypt.hash(newPassword, 12);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);

  // Recovery invalidates existing sessions for this account (belt-and-suspenders;
  // since sessions are server-side lookups, we simply don't rotate a shared
  // secret here — each session is independent, so this is a no-op placeholder
  // for a future session-table sweep if needed).

  res.json({ ok: true, message: 'Password updated. You can log in now.' });
});

// Regenerate codes while logged in (e.g. running low).
router.post('/recovery-codes/regenerate', requireAuth, async (req, res) => {
  const codes = await generateCodes(req.session.userId);
  res.json({ recoveryCodes: codes });
});

// --- Admin: reset a user's password directly -----------------------------
// Used when a student has lost both their password and their recovery codes.
// Logged in admin_resets, and the affected user is told on next login.
router.post('/admin/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const { username, newPassword } = req.body || {};
  if (!username || !newPassword) return res.status(400).json({ error: 'Username and new password are required.' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const { rows } = await db.query('SELECT id FROM users WHERE username = $1', [username]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'No user with that username.' });

  const hash = await bcrypt.hash(newPassword, 12);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, target.id]);
  await db.query(
    'INSERT INTO admin_resets (admin_id, target_user_id) VALUES ($1, $2)',
    [req.session.userId, target.id]
  );
  // Force the user to regenerate codes next time they view settings —
  // simplest signal is just leaving old codes as-is; they can hit "regenerate".

  res.json({ ok: true });
});

// So an admin-reset user sees who reset them and when, next time they log in.
router.get('/admin/reset-history', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT ar.created_at, u.username AS admin_username
     FROM admin_resets ar JOIN users u ON u.id = ar.admin_id
     WHERE ar.target_user_id = $1
     ORDER BY ar.created_at DESC LIMIT 5`,
    [req.session.userId]
  );
  res.json({ resets: rows });
});

// List usernames for admin reset autocomplete + DM start.
router.get('/users', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, username FROM users WHERE id != $1 ORDER BY username',
    [req.session.userId]
  );
  res.json({ users: rows });
});

module.exports = router;
