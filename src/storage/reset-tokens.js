const crypto = require("crypto");
const { db } = require("./db");

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const createTokenStatement = db.prepare(`
  INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
  VALUES (@user_id, @token_hash, @expires_at)
`);

const findTokenStatement = db.prepare(`
  SELECT *
  FROM password_reset_tokens
  WHERE token_hash = ?
    AND used = 0
    AND expires_at > CURRENT_TIMESTAMP
`);

const markTokenUsedStatement = db.prepare(`
  UPDATE password_reset_tokens
  SET used = 1
  WHERE id = ?
`);

const purgeOldTokensStatement = db.prepare(`
  DELETE FROM password_reset_tokens
  WHERE used = 1 OR expires_at < CURRENT_TIMESTAMP
`);

function createResetToken(userId) {
  purgeOldTokensStatement.run();

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  createTokenStatement.run({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt });

  return token;
}

function findValidToken(rawToken) {
  if (!rawToken) return null;
  return findTokenStatement.get(hashToken(rawToken));
}

function consumeToken(tokenId) {
  markTokenUsedStatement.run(tokenId);
}

module.exports = { createResetToken, findValidToken, consumeToken };
