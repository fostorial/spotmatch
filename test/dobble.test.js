const test = require("node:test");
const assert = require("node:assert/strict");

const { generateDeckForVersion, generateSpotMatchDeck, requiredSymbolCount } = require("../src/utils/dobble");

test("generateSpotMatchDeck creates cards that share exactly one symbol", () => {
  const symbolsPerCard = 4;
  const symbolCount = requiredSymbolCount(symbolsPerCard);
  const symbols = Array.from({ length: symbolCount }, (_, index) => `Symbol ${index + 1}`);
  const deck = generateSpotMatchDeck(symbols, symbolsPerCard);

  assert.equal(deck.cards.length, symbolCount);

  for (let index = 0; index < deck.cards.length; index += 1) {
    for (let compareIndex = index + 1; compareIndex < deck.cards.length; compareIndex += 1) {
      const shared = deck.cards[index].filter((symbol) => deck.cards[compareIndex].includes(symbol));
      assert.equal(shared.length, 1);
    }
  }
});

test("generateDeckForVersion matches commercial junior and classic card counts", () => {
  const junior = generateDeckForVersion("Animals", "junior");
  const classic = generateDeckForVersion("Space", "classic");

  assert.equal(junior.cards.length, 30);
  assert.equal(junior.symbols.length, 31);
  assert.equal(classic.cards.length, 55);
  assert.equal(classic.symbols.length, 57);
});
