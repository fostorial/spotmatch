const { db } = require("./db");

const createUserStatement = db.prepare(`
  INSERT INTO users (username, email, password_hash)
  VALUES (@username, @email, @password_hash)
`);

const findUserByUsernameStatement = db.prepare(`
  SELECT *
  FROM users
  WHERE LOWER(username) = LOWER(?)
`);

const findUserByIdStatement = db.prepare(`
  SELECT *
  FROM users
  WHERE id = ?
`);

const findUserByEmailStatement = db.prepare(`
  SELECT *
  FROM users
  WHERE LOWER(email) = LOWER(?)
`);

const updatePasswordStatement = db.prepare(`
  UPDATE users
  SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const updateEmailStatement = db.prepare(`
  UPDATE users
  SET email = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const createAdminUserStatement = db.prepare(`
  INSERT INTO users (username, password_hash, is_admin)
  VALUES (@username, @password_hash, 1)
`);

const getAllUsersWithDeckCountsStatement = db.prepare(`
  SELECT u.id, u.username, u.email, u.is_admin, u.created_at,
         COUNT(d.id) AS deck_count
  FROM users u
  LEFT JOIN decks d ON d.user_id = u.id
  GROUP BY u.id
  ORDER BY u.username COLLATE NOCASE
`);

function createUser(username, passwordHash, email) {
  const info = createUserStatement.run({
    username,
    email: email || null,
    password_hash: passwordHash
  });

  return findUserById(info.lastInsertRowid);
}

function findUserByUsername(username) {
  return findUserByUsernameStatement.get(username);
}

function findUserById(id) {
  return findUserByIdStatement.get(id);
}

function findUserByEmail(email) {
  if (!email) return null;
  return findUserByEmailStatement.get(email);
}

function updateUserPassword(userId, passwordHash) {
  return updatePasswordStatement.run(passwordHash, userId);
}

function updateUserEmail(userId, email) {
  return updateEmailStatement.run(email, userId);
}

function createAdminUser(username, passwordHash) {
  const info = createAdminUserStatement.run({ username, password_hash: passwordHash });
  return findUserById(info.lastInsertRowid);
}

function getAllUsersWithDeckCounts() {
  return getAllUsersWithDeckCountsStatement.all();
}

module.exports = {
  createAdminUser,
  createUser,
  findUserById,
  findUserByEmail,
  findUserByUsername,
  getAllUsersWithDeckCounts,
  updateUserEmail,
  updateUserPassword
};
