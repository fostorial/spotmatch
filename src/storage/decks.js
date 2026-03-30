const { db } = require("./db");

const listDecksByUserIdStatement = db.prepare(`
  SELECT *
  FROM decks
  WHERE user_id = ?
  ORDER BY updated_at DESC, id DESC
`);

const findDeckByIdForUserStatement = db.prepare(`
  SELECT *
  FROM decks
  WHERE id = ? AND user_id = ?
`);

const findDeckByIdStatement = db.prepare(`
  SELECT *
  FROM decks
  WHERE id = ?
`);

const createDeckStatement = db.prepare(`
  INSERT INTO decks (
    user_id,
    title,
    version,
    description,
    symbols_per_card,
    symbols_text,
    total_symbols,
    total_cards,
    generated_cards_json
  )
  VALUES (
    @user_id,
    @title,
    @version,
    @description,
    @symbols_per_card,
    @symbols_text,
    @total_symbols,
    @total_cards,
    @generated_cards_json
  )
`);

const updateDeckStatement = db.prepare(`
  UPDATE decks
  SET
    title = @title,
    version = @version,
    description = @description,
    symbols_per_card = @symbols_per_card,
    symbols_text = @symbols_text,
    total_symbols = @total_symbols,
    total_cards = @total_cards,
    generated_cards_json = @generated_cards_json,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = @id AND user_id = @user_id
`);

const deleteDeckStatement = db.prepare(`
  DELETE FROM decks
  WHERE id = ? AND user_id = ?
`);

const updateDeckCardBackStatement = db.prepare(`
  UPDATE decks
  SET card_back_image = @card_back_image, updated_at = CURRENT_TIMESTAMP
  WHERE id = @id AND user_id = @user_id
`);

const updateDeckSymbolsStatement = db.prepare(`
  UPDATE decks
  SET
    symbols_text = @symbols_text,
    total_symbols = @total_symbols,
    total_cards = @total_cards,
    generated_cards_json = @generated_cards_json,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = @id AND user_id = @user_id
`);

function createDeck(userId, input, generatedDeck) {
  createDeckStatement.run({
    user_id: userId,
    title: input.title,
    version: input.version,
    description: input.description,
    symbols_per_card: input.symbolsPerCard,
    symbols_text: input.symbolsText,
    total_symbols: generatedDeck.symbols.length,
    total_cards: generatedDeck.cards.length,
    generated_cards_json: JSON.stringify(generatedDeck.cards)
  });
}

function updateDeck(deckId, userId, input, generatedDeck) {
  updateDeckStatement.run({
    id: deckId,
    user_id: userId,
    title: input.title,
    version: input.version,
    description: input.description,
    symbols_per_card: input.symbolsPerCard,
    symbols_text: input.symbolsText,
    total_symbols: generatedDeck.symbols.length,
    total_cards: generatedDeck.cards.length,
    generated_cards_json: JSON.stringify(generatedDeck.cards)
  });
}

function listDecksByUserId(userId) {
  return listDecksByUserIdStatement.all(userId);
}

function findDeckByIdForUser(deckId, userId) {
  return findDeckByIdForUserStatement.get(deckId, userId);
}

function findDeckById(deckId) {
  return findDeckByIdStatement.get(deckId);
}

function deleteDeckById(deckId, userId) {
  deleteDeckStatement.run(deckId, userId);
}

function updateDeckCardBack(deckId, userId, imageData) {
  updateDeckCardBackStatement.run({ id: deckId, user_id: userId, card_back_image: imageData });
}

function clearDeckCardBack(deckId, userId) {
  updateDeckCardBackStatement.run({ id: deckId, user_id: userId, card_back_image: null });
}

function updateDeckFromSymbols(deckId, userId, symbolsText, generatedDeck) {
  updateDeckSymbolsStatement.run({
    id: deckId,
    user_id: userId,
    symbols_text: symbolsText,
    total_symbols: generatedDeck.symbols.length,
    total_cards: generatedDeck.cards.length,
    generated_cards_json: JSON.stringify(generatedDeck.cards)
  });
}

module.exports = {
  createDeck,
  clearDeckCardBack,
  deleteDeckById,
  findDeckById,
  findDeckByIdForUser,
  listDecksByUserId,
  updateDeckCardBack,
  updateDeckFromSymbols,
  updateDeck
};
