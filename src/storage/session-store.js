const session = require("express-session");
const { db } = require("./db");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
`);

const getStatement = db.prepare(`
  SELECT sess
  FROM sessions
  WHERE sid = ? AND expires_at > ?
`);

const upsertStatement = db.prepare(`
  INSERT INTO sessions (sid, sess, expires_at)
  VALUES (?, ?, ?)
  ON CONFLICT(sid) DO UPDATE SET
    sess = excluded.sess,
    expires_at = excluded.expires_at
`);

const destroyStatement = db.prepare(`
  DELETE FROM sessions
  WHERE sid = ?
`);

const pruneStatement = db.prepare(`
  DELETE FROM sessions
  WHERE expires_at <= ?
`);

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    this.pruneExpiredSessions();
  }

  get(sid, callback) {
    try {
      const row = getStatement.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sessionData, callback) {
    try {
      upsertStatement.run(sid, JSON.stringify(sessionData), this.resolveExpiry(sessionData));
      if (callback) {
        callback(null);
      }
    } catch (error) {
      if (callback) {
        callback(error);
      }
    }
  }

  destroy(sid, callback) {
    try {
      destroyStatement.run(sid);
      if (callback) {
        callback(null);
      }
    } catch (error) {
      if (callback) {
        callback(error);
      }
    }
  }

  touch(sid, sessionData, callback) {
    this.set(sid, sessionData, callback);
  }

  resolveExpiry(sessionData) {
    if (sessionData.cookie && sessionData.cookie.expires) {
      return new Date(sessionData.cookie.expires).getTime();
    }

    return Date.now() + 1000 * 60 * 60 * 8;
  }

  pruneExpiredSessions() {
    try {
      pruneStatement.run(Date.now());
    } catch (_error) {
      return;
    }
  }
}

module.exports = {
  SqliteSessionStore
};
