const bcrypt = require('bcryptjs');
const { customAlphabet } = require('nanoid');
const db = require('./db');

// Unambiguous alphabet: no 0/O, 1/I/L confusion.
const nanoid = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 5);

function formatCode() {
  return `${nanoid()}-${nanoid()}`; // e.g. "7XQK9-M3PLR"
}

const CODE_COUNT = 10;

// Generates a fresh set of recovery codes for a user, invalidating any
// existing unused codes. Returns the plaintext codes (shown once, never
// stored in plaintext).
async function generateCodes(userId) {
  await db.query('DELETE FROM recovery_codes WHERE user_id = $1 AND used = FALSE', [userId]);

  const plainCodes = Array.from({ length: CODE_COUNT }, formatCode);
  for (const code of plainCodes) {
    const hash = await bcrypt.hash(code, 10);
    await db.query(
      'INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)',
      [userId, hash]
    );
  }
  return plainCodes;
}

// Verifies a submitted code against a user's stored (unused) codes.
// On success, burns the code and returns true.
async function verifyAndBurnCode(userId, submittedCode) {
  const { rows } = await db.query(
    'SELECT id, code_hash FROM recovery_codes WHERE user_id = $1 AND used = FALSE',
    [userId]
  );
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const match = await bcrypt.compare(submittedCode.trim(), row.code_hash);
    if (match) {
      await db.query('UPDATE recovery_codes SET used = TRUE WHERE id = $1', [row.id]);
      return true;
    }
  }
  return false;
}

async function remainingCount(userId) {
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used = FALSE',
    [userId]
  );
  return rows[0].n;
}

module.exports = { generateCodes, verifyAndBurnCode, remainingCount, CODE_COUNT };
