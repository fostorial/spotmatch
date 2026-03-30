const { db } = require("./db");

const listSymbolsByDeckIdStatement = db.prepare(`
  SELECT *
  FROM deck_symbols
  WHERE deck_id = ?
  ORDER BY display_order ASC, id ASC
`);

const findSymbolByIdForUserStatement = db.prepare(`
  SELECT deck_symbols.*, decks.user_id, decks.version, decks.title, decks.symbols_per_card
  FROM deck_symbols
  INNER JOIN decks ON decks.id = deck_symbols.deck_id
  WHERE deck_symbols.id = ? AND deck_symbols.deck_id = ? AND decks.user_id = ?
`);

const deleteSymbolsByDeckIdStatement = db.prepare(`
  DELETE FROM deck_symbols
  WHERE deck_id = ?
`);

const insertSymbolStatement = db.prepare(`
  INSERT INTO deck_symbols (deck_id, display_order, label, image_data)
  VALUES (?, ?, ?, ?)
`);

const updateSymbolStatement = db.prepare(`
  UPDATE deck_symbols
  SET label = ?, image_data = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ? AND deck_id = ?
`);

function listSymbolsByDeckId(deckId) {
  return listSymbolsByDeckIdStatement.all(deckId);
}

function findSymbolByIdForUser(symbolId, deckId, userId) {
  return findSymbolByIdForUserStatement.get(symbolId, deckId, userId);
}

function replaceSymbolsForDeck(deckId, labels, existingSymbols) {
  db.exec("BEGIN");

  try {
    deleteSymbolsByDeckIdStatement.run(deckId);

    labels.forEach((label, index) => {
      const existing = existingSymbols[index];
      insertSymbolStatement.run(deckId, index, label, existing ? existing.image_data : null);
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function updateSymbol(symbolId, deckId, label, imageData) {
  updateSymbolStatement.run(label, imageData, symbolId, deckId);
}

module.exports = {
  findSymbolByIdForUser,
  listSymbolsByDeckId,
  replaceSymbolsForDeck,
  updateSymbol
};
