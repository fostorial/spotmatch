/**
 * Child process for PDF generation.
 *
 * Accepts a single command-line argument: the deck ID.
 * Opens the application database read-only (WAL mode allows concurrent reads
 * alongside the main server's write connection), fetches the deck and symbols
 * itself, generates the PDF, and writes the bytes to stdout.
 *
 * This avoids serialising potentially hundreds of MB of base64 image data
 * through a pipe, which was causing the process to be OOM-killed.
 *
 * Running as a separate OS process (not a worker thread) means that if the
 * OS OOM-killer fires during generation it only takes down this child — the
 * main server process continues running.
 */

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { generateDeckPdf } = require("./utils/pdf-export");

const deckId = Number(process.argv[2]);

if (!deckId) {
  process.stderr.write("export-child: missing deck ID argument\n");
  process.exit(1);
}

// Resolve the same database path that db.js uses:
//   src/storage/db.js  →  ../../data/app.sqlite  →  <project-root>/data/app.sqlite
// This file is at src/export-child.js, so one level up is the project root.
const dbPath = path.join(__dirname, "..", "data", "app.sqlite");

let db;
try {
  db = new DatabaseSync(dbPath, { open: true });
} catch (err) {
  process.stderr.write("export-child: failed to open database: " + err.message + "\n");
  process.exit(1);
}

let deck;
let symbols;
try {
  deck = db.prepare("SELECT * FROM decks WHERE id = ?").get(deckId);
  if (!deck) {
    process.stderr.write("export-child: deck " + deckId + " not found\n");
    process.exit(1);
  }

  symbols = db
    .prepare("SELECT * FROM deck_symbols WHERE deck_id = ? ORDER BY display_order ASC, id ASC")
    .all(deckId);
} catch (err) {
  process.stderr.write("export-child: database query failed: " + err.message + "\n");
  process.exit(1);
}

// Close the DB connection before the heavy PDF generation so we are not
// holding any SQLite lock while PDFKit runs.
try {
  db.close();
} catch (_) {
  // Non-fatal — WAL allows concurrent readers so a missed close is harmless.
}

try {
  const doc = generateDeckPdf(deck, symbols, []);

  doc.on("error", (err) => {
    process.stderr.write("export-child: pdf error: " + err.message + "\n");
    process.exit(1);
  });

  doc.pipe(process.stdout);
  doc.end();
} catch (err) {
  process.stderr.write(
    "export-child: generation failed: " + (err && err.message ? err.message : String(err)) + "\n"
  );
  process.exit(1);
}
