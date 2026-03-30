/**
 * Child process for ZIP/PNG deck export.
 *
 * Accepts a single command-line argument: the deck ID.
 * Opens the application database independently (WAL mode allows concurrent
 * reads alongside the main server's write connection), fetches the deck and
 * symbols, generates per-card PNGs, and streams the ZIP archive to stdout.
 *
 * Running as a separate OS process means an OOM kill only takes down this
 * child — the main server process keeps running.
 */

"use strict";

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { generateDeckZip } = require("./utils/zip-export");

const deckId = Number(process.argv[2]);

if (!deckId) {
  process.stderr.write("zip-child: missing deck ID argument\n");
  process.exit(1);
}

// Resolve the same database path that db.js uses.
const dbPath = path.join(__dirname, "..", "data", "app.sqlite");

let db;
try {
  db = new DatabaseSync(dbPath, { open: true });
} catch (err) {
  process.stderr.write("zip-child: failed to open database: " + err.message + "\n");
  process.exit(1);
}

let deck;
let symbols;
try {
  deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(deckId);
  if (!deck) {
    process.stderr.write("zip-child: deck " + deckId + " not found\n");
    process.exit(1);
  }

  symbols = db
    .prepare("SELECT * FROM deck_symbols WHERE deck_id = ? ORDER BY display_order ASC, id ASC")
    .all(deckId);
} catch (err) {
  process.stderr.write("zip-child: database query failed: " + err.message + "\n");
  process.exit(1);
}

// Close the DB before the heavy PNG generation so we hold no SQLite lock.
try {
  db.close();
} catch (_) {
  // Non-fatal.
}

try {
  const archive = generateDeckZip(deck, symbols);

  archive.on("error", (err) => {
    process.stderr.write("zip-child: archive error: " + err.message + "\n");
    process.exit(1);
  });

  // Pipe first, then finalize — archiver streams entries to stdout as they
  // are processed rather than buffering the entire archive in memory.
  archive.pipe(process.stdout);
  archive.finalize();
} catch (err) {
  process.stderr.write(
    "zip-child: generation failed: " + (err && err.message ? err.message : String(err)) + "\n"
  );
  process.exit(1);
}
