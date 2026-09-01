# Room One

A single-class chat app: one group room, private messages between classmates,
username/password auth with recovery codes (no email or phone number),
real-time delivery over WebSockets, and group messages that expire after 9
days unless someone saves them. DMs persist indefinitely.

## How it matches the design we whiteboarded

- **Auth & recovery (Approach B)** — recovery codes are the self-service fast
  path (`/api/auth/recover`); if a student loses both password and codes, an
  admin can reset directly (`/api/auth/admin/reset-password`). Every admin
  reset is logged in `admin_resets` and shown to the affected user in
  Settings next time they log in.
- **9-day TTL, group-only** — `server/sweeper.js` runs hourly and hard-deletes
  unsaved messages in the group room older than 9 days. DMs (`room.type =
  'dm'`) are never touched. Starring a message (`saved = true`) exempts it.
- **Missed-message catch-up (Approach 2 — server-side cursor)** — `read_cursors`
  tracks the last message each user has seen per room. On WebSocket reconnect
  the server compares against this cursor and pushes exactly what was missed,
  so it survives cleared browser storage or a new device.
- **Live delete propagation** — when the sweeper deletes a message, it
  broadcasts `messages_deleted` over the existing room socket set so any open
  tab removes it immediately instead of waiting for a reload.
- **Single process, single Postgres instance** — no Redis, no multi-instance
  pub/sub. At <500 users this is the right amount of infrastructure; the
  upgrade path if this ever grows is documented as a comment in `server/ws.js`.

## Local development

```bash
npm install
cp .env.example .env
# point DATABASE_URL at a local Postgres instance
npm start
```

The app runs migrations automatically on boot (`server/migrate.js` applies
`schema.sql`, which is idempotent — safe to run on every deploy).

Visit `http://localhost:3000`. The **first account you register becomes the
admin** — do this first, before sharing the link with the class.

## Deploying to Railway

The app (Node process + WebSocket server) always runs on Railway — it needs
a long-running process to hold WebSocket connections open, which rules out
serverless/edge-function hosts for this part. The **database** can be either
Railway's own Postgres plugin, or an external Supabase Postgres instance.
Pick one of the two "Database" options below, then continue with "App".

### Database, option A: Railway Postgres (simplest)

1. In your Railway project: **Add a plugin → PostgreSQL.**
2. Railway sets `DATABASE_URL` on your app service automatically — nothing
   else to configure.

### Database, option B: Supabase Postgres

1. Create a project at supabase.com (free tier is fine for this scale).
2. In the Supabase dashboard: **Project Settings → Database → Connection
   string → URI.** Copy the **direct connection** (port 5432) or **Session
   pooler** string — not the **Transaction pooler** (port 6543); this app
   keeps a persistent connection pool open (queries + the session store),
   which transaction-mode pooling doesn't handle well.
3. In Railway, on your app service's **Variables**, set `DATABASE_URL` to
   that Supabase string. SSL is detected automatically from the `supabase`
   in the hostname, so no extra flag is needed.
4. Know the tradeoff: Supabase's free tier pauses the database after a week
   of inactivity, which would silently break login and the sweeper until
   someone opens the Supabase dashboard to unpause it. Worth checking their
   current docs before relying on this for a real class, since free-tier
   behavior changes over time.

### App (either way)

1. Push this project to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
3. Complete whichever Database option you chose above.
4. In your app service's **Variables**, add `SESSION_SECRET` (a long random
   string — see `.env.example` for how to generate one) and `NODE_ENV=production`.
5. Deploy. Railway builds with Nixpacks and runs `npm start`, which runs
   migrations then starts the server — no separate migration step needed.
6. Open the generated URL, register the first account (this becomes admin),
   then share the link with the class.

**Before relying on this for a real class**, confirm in Railway's current
docs that your plan doesn't sleep the process when idle — a sleeping process
means WebSocket connections drop silently and the hourly sweeper won't run on
schedule. This is worth checking directly against Railway's docs since plan
behavior changes over time.

## Rooms, classes, and members

- Any admin can create additional group rooms (Settings → "Admin: rooms &
  classes") — one per class. Every room name is visible to everyone in the
  sidebar; opening one you're not a member of shows an access-denied screen
  instead of the chat.
- Admins add/remove specific students per room from the same panel. A student
  who's currently online gets pushed straight into the room over their open
  WebSocket connection — no refresh needed. One who isn't online picks up the
  new room automatically on next login.
- Inside any group room, "View members" in the header lists who's currently
  in it. Only members of a room can see its member list — this is enforced
  server-side, not just hidden in the UI.
- The first account registered (the admin) is auto-added to whatever group
  room(s) already exist at that moment, so there's no chicken-and-egg problem
  bootstrapping the very first class.
- Registration's rate limit was raised from the original overly strict
  setting — a classroom sitting behind one shared school IP was hitting it
  within a few signups. Login and password-recovery remain tightly rate
  limited, since those are the actual brute-force-sensitive paths.

## What's deliberately not built

To match the stated scale (<500 users, one class) and avoid infrastructure
that adds risk without adding value here:

- No Redis / multi-instance WebSocket fan-out — single process handles this
  fine; see the comment block in `server/ws.js` for the upgrade path.
- No email/phone/SSO — recovery is codes + admin, by design.
- No message editing, reactions, or file attachments — not in the original brief.
- Rate limiting is in-memory (`server/rateLimit.js`) — fine for one process,
  would need to move to a shared store (e.g. Redis) if you ever scale to
  multiple instances.

## Project structure

```
server/
  index.js        entry point: express app, sessions, WS, sweeper wiring
  db.js           Postgres pool
  migrate.js      applies schema.sql on boot
  ws.js           WebSocket auth, room fan-out, missed-message catch-up
  sweeper.js      hourly TTL job for unsaved group messages
  recoveryCodes.js  generate/verify/burn recovery codes
  rateLimit.js    minimal in-memory rate limiter
  middleware.js   requireAuth / requireAdmin
  routes/
    auth.js       register, login, logout, recover, admin reset
    rooms.js      room list, DM creation, message history, save/unsave
public/
  index.html      login / register / recovery gate
  app.html        main app shell
  css/style.css
  js/gate.js      gate page logic
  js/app.js       main app logic (rooms, WS, settings, admin)
schema.sql        Postgres schema (idempotent)
railway.json      Railway deploy config
```
