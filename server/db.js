const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';
// Managed hosts (Railway, Supabase, and most others) require SSL but use
// certs that fail strict verification through connection poolers — this
// matches standard practice for those hosts. PGSSL=true is the manual
// override for any other managed provider not auto-detected here.
const needsSSL = /supabase|railway/.test(url) || process.env.PGSSL === 'true';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSSL ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres error on idle client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
