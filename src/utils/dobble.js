const SPOTMATCH_VERSIONS = {
  junior: {
    key: "junior",
    label: "Junior",
    symbolsPerCard: 6,
    publishedCardCount: 30
  },
  classic: {
    key: "classic",
    label: "Classic",
    symbolsPerCard: 8,
    publishedCardCount: 55
  }
};

function requiredSymbolCount(symbolsPerCard) {
  const order = symbolsPerCard - 1;
  return order * order + order + 1;
}

function getSpotMatchVersion(versionKey) {
  return SPOTMATCH_VERSIONS[String(versionKey || "").toLowerCase()] || null;
}

function validateDeckInput(input) {
  const errors = [];
  const title = String(input.title || "").trim();
  const version = getSpotMatchVersion(input.version);

  if (!title || title.length < 3 || title.length > 80) {
    errors.push("Title must be between 3 and 80 characters.");
  }

  if (!version) {
    errors.push("Choose either Junior or Classic.");
  }

  return errors;
}

function buildDefaultSymbols(title, version) {
  const cleanTitle = String(title || "").trim();
  const count = requiredSymbolCount(version.symbolsPerCard);
  return Array.from({ length: count }, (_value, index) => `${cleanTitle} symbol ${index + 1}`);
}

function buildSpotMatchIndexCards(symbolsPerCard) {
  const order = symbolsPerCard - 1;
  const cards = [];
  const firstCard = [0];

  for (let index = 1; index <= order; index += 1) {
    firstCard.push(index);
  }

  cards.push(firstCard);

  for (let row = 0; row < order; row += 1) {
    const card = [0];
    for (let column = 0; column < order; column += 1) {
      card.push(order + 1 + order * row + column);
    }
    cards.push(card);
  }

  for (let slope = 0; slope < order; slope += 1) {
    for (let intercept = 0; intercept < order; intercept += 1) {
      const card = [slope + 1];
      for (let column = 0; column < order; column += 1) {
        const symbolIndex = order + 1 + order * column + ((slope * column + intercept) % order);
        card.push(symbolIndex);
      }
      cards.push(card);
    }
  }

  return cards;
}

function generateSpotMatchDeck(symbols, symbolsPerCard) {
  const required = requiredSymbolCount(symbolsPerCard);

  if (symbols.length !== required) {
    throw new Error("Unexpected symbol count");
  }

  const cards = buildSpotMatchIndexCards(symbolsPerCard);

  return {
    symbols,
    cards: cards.map((card) => card.map((symbolIndex) => symbols[symbolIndex]))
  };
}

function generateDeckForVersion(title, versionKey) {
  const version = getSpotMatchVersion(versionKey);

  if (!version) {
    throw new Error("Unsupported SpotMatch version");
  }

  const symbols = buildDefaultSymbols(title, version);
  const fullDeck = generateSpotMatchDeck(symbols, version.symbolsPerCard);

  return {
    version,
    symbols: fullDeck.symbols,
    cards: fullDeck.cards.slice(0, version.publishedCardCount),
    symbolsText: symbols.join("\n")
  };
}

function generateDeckFromSymbols(versionKey, symbols) {
  const version = getSpotMatchVersion(versionKey);

  if (!version) {
    throw new Error("Unsupported SpotMatch version");
  }

  const fullDeck = generateSpotMatchDeck(symbols, version.symbolsPerCard);

  return {
    version,
    symbols: fullDeck.symbols,
    cards: fullDeck.cards.slice(0, version.publishedCardCount),
    symbolsText: symbols.join("\n")
  };
}

function buildDeckStats(decks) {
  const totalDecks = decks.length;
  const totalCards = decks.reduce((sum, deck) => sum + deck.total_cards, 0);
  const totalSymbols = decks.reduce((sum, deck) => sum + deck.total_symbols, 0);

  return {
    totalDecks,
    totalCards,
    totalSymbols
  };
}

module.exports = {
  SPOTMATCH_VERSIONS,
  buildDeckStats,
  buildSpotMatchIndexCards,
  buildDefaultSymbols,
  generateDeckFromSymbols,
  generateDeckForVersion,
  generateSpotMatchDeck,
  getSpotMatchVersion,
  requiredSymbolCount,
  validateDeckInput
};
