// Minimal in-memory rate limiter keyed by a string (e.g. `${ip}:${username}`).
// Good enough for a single-process deployment at small scale. If this ever
// runs across multiple instances, swap the Map for Redis.

const buckets = new Map();

function rateLimit({ windowMs, max }) {
  return (keyFn) => {
    const key = typeof keyFn === 'function' ? keyFn : () => keyFn;
    return (req, res, next) => {
      const k = key(req);
      const now = Date.now();
      const entry = buckets.get(k) || { count: 0, resetAt: now + windowMs };
      if (now > entry.resetAt) {
        entry.count = 0;
        entry.resetAt = now + windowMs;
      }
      entry.count += 1;
      buckets.set(k, entry);
      if (entry.count > max) {
        const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
        res.set('Retry-After', String(retryAfterSec));
        return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
      }
      next();
    };
  };
}

// Periodic cleanup so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (now > v.resetAt) buckets.delete(k);
  }
}, 5 * 60 * 1000).unref();

module.exports = rateLimit;
