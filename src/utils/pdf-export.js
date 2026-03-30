const PDFDocument = require("pdfkit");
const { buildSpotMatchIndexCards } = require("./dobble");
const { createPlaceholderPngBuffer, getPlaceholderImageDataUrl } = require("./placeholder");
const { resizePngBuffer } = require("./png");

// Card back fills the full 85 mm card circle (~1003 px at 300 DPI).
const MAX_CARD_BACK_PX = 1024;

const MM_TO_PT = 72 / 25.4;
const A4 = {
  width: 210 * MM_TO_PT,
  height: 297 * MM_TO_PT
};

const CARD_DIAMETER = 85 * MM_TO_PT;
const CARD_RADIUS = CARD_DIAMETER / 2;
const CARD_GAP = 7 * MM_TO_PT;
const CARD_COLS = 2;
const CARD_ROWS = 3;
const CARDS_PER_PAGE = CARD_COLS * CARD_ROWS;
const MIN_SYMBOL_SURFACE_RATIO = 0.55;
const MIN_SYMBOL_SIZE_FACTOR = 0.2;
const MAX_SYMBOL_SIZE_FACTOR = 1;

// Computed once at module load — never changes between requests.
const CARD_SLOTS = (function buildCardSlots() {
  const totalWidth = CARD_COLS * CARD_DIAMETER + (CARD_COLS - 1) * CARD_GAP;
  const totalHeight = CARD_ROWS * CARD_DIAMETER + (CARD_ROWS - 1) * CARD_GAP;
  const startX = (A4.width - totalWidth) / 2 + CARD_RADIUS;
  const startY = (A4.height - totalHeight) / 2 + CARD_RADIUS;
  const slots = [];

  for (let row = 0; row < CARD_ROWS; row += 1) {
    for (let col = 0; col < CARD_COLS; col += 1) {
      slots.push({
        x: startX + col * (CARD_DIAMETER + CARD_GAP),
        y: startY + row * (CARD_DIAMETER + CARD_GAP)
      });
    }
  }

  return slots;
}());

const LAYOUTS = {
  6: [
    { x: 0, y: 0, size: 1 },
    { x: 0, y: -0.58, size: 0.63 },
    { x: 0.52, y: -0.34, size: 0.56 },
    { x: 0.5, y: 0.36, size: 0.64 },
    { x: -0.52, y: 0.34, size: 0.7 },
    { x: -0.5, y: -0.28, size: 0.5 }
  ],
  8: [
    { x: 0, y: 0, size: 1 },
    { x: 0, y: -0.62, size: 0.52 },
    { x: 0.46, y: -0.46, size: 0.5 },
    { x: 0.6, y: 0, size: 0.44 },
    { x: 0.45, y: 0.46, size: 0.56 },
    { x: 0, y: 0.62, size: 0.54 },
    { x: -0.47, y: 0.44, size: 0.6 },
    { x: -0.59, y: -0.05, size: 0.46 }
  ]
};

function createSeededRandom(seedInput) {
  let seed = 0;
  const text = String(seedInput);

  for (let index = 0; index < text.length; index += 1) {
    seed = (seed * 31 + text.charCodeAt(index)) >>> 0;
  }

  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

// Decode a stored data URL to a raw buffer without re-normalising.
// Images are already normalised to RGBA PNG when uploaded, so a plain
// base64 decode is all that's needed here.
function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl).match(/^data:image\/png;base64,(.+)$/);
  return match ? Buffer.from(match[1], "base64") : null;
}

// Build a Map<symbolId, Buffer> once per export.  Each unique symbol's image
// is decoded exactly once; the same Buffer instance is reused for every card
// that contains that symbol, which lets PDFKit embed the image only once in
// the PDF instead of once per occurrence.
// Images are already scaled to ≤512 px at upload time, so no resize is needed here.
function buildSymbolImageCache(symbols) {
  const placeholder = createPlaceholderPngBuffer();
  const cache = new Map();

  for (const symbol of symbols) {
    if (!symbol) {
      continue;
    }

    const buffer = symbol.image_data ? dataUrlToBuffer(symbol.image_data) : null;

    cache.set(symbol.id, buffer || placeholder);
  }

  return cache;
}

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function drawPageBackground(doc) {
  doc.save();
  doc.rect(0, 0, A4.width, A4.height).fill("#fffdf8");
  doc.restore();
}

function drawCardBase(doc, centerX, centerY) {
  doc.save();
  doc.circle(centerX, centerY, CARD_RADIUS).fillAndStroke("#ffffff", "#ddcff8");
  doc.circle(centerX, centerY, CARD_RADIUS - 4).stroke("#f3d44d");
  doc.restore();
}

function computePlacement(layoutEntry, random) {
  const radialJitter = 0.92 + random() * 0.18;
  const tangentialJitter = (random() - 0.5) * CARD_RADIUS * 0.18;
  const baseX = layoutEntry.x * CARD_RADIUS * radialJitter;
  const baseY = layoutEntry.y * CARD_RADIUS * radialJitter;
  const tangentX = -layoutEntry.y * tangentialJitter;
  const tangentY = layoutEntry.x * tangentialJitter;
  const maxLayoutSize = CARD_DIAMETER * 0.33;
  const normalizedSize = MIN_SYMBOL_SIZE_FACTOR + (MAX_SYMBOL_SIZE_FACTOR - MIN_SYMBOL_SIZE_FACTOR) * layoutEntry.size;
  const size = maxLayoutSize * normalizedSize * (0.88 + random() * 0.18);
  const maxRadius = CARD_RADIUS - size / 2 - 10;
  let x = baseX + tangentX;
  let y = baseY + tangentY;
  const distance = Math.sqrt(x * x + y * y);

  if (distance > maxRadius && distance > 0) {
    const scale = maxRadius / distance;
    x *= scale;
    y *= scale;
  }

  return {
    x,
    y,
    size,
    angle: random() * 360
  };
}

function getSurfaceCoverageRatio(placements) {
  const symbolSurfaceArea = placements.reduce((sum, placement) => {
    const radius = placement.size / 2;
    return sum + Math.PI * radius * radius;
  }, 0);

  return symbolSurfaceArea / (Math.PI * CARD_RADIUS * CARD_RADIUS);
}

function enforceMinimumCoverage(placements) {
  const coverageRatio = getSurfaceCoverageRatio(placements);

  if (coverageRatio >= MIN_SYMBOL_SURFACE_RATIO) {
    return placements;
  }

  const scaleMultiplier = Math.sqrt(MIN_SYMBOL_SURFACE_RATIO / coverageRatio) * 1.01;

  return placements.map((placement) => ({
    ...placement,
    size: placement.size * scaleMultiplier
  }));
}

function resolveOverlaps(placements) {
  let minScale = 1.0;

  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      const a = placements[i];
      const b = placements[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const combinedRadius = (a.size + b.size) / 2;

      if (combinedRadius > 0 && dist < combinedRadius) {
        minScale = Math.min(minScale, dist / combinedRadius);
      }
    }
  }

  if (minScale >= 1.0) {
    return placements;
  }

  const safeScale = minScale * 0.97;
  return placements.map((p) => ({ ...p, size: p.size * safeScale }));
}

function shuffleArray(array, random) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}

function buildCardPlacements(deck, cardIndex, cardSymbols) {
  const layout = LAYOUTS[deck.symbols_per_card];
  const random = createSeededRandom(`${deck.id}:${cardIndex}:${deck.title}`);

  const shuffledLayout = shuffleArray(layout, random);
  const placements = cardSymbols.map((_symbol, index) => computePlacement(shuffledLayout[index], random));
  return resolveOverlaps(enforceMinimumCoverage(placements));
}

function drawSymbol(doc, imageBuffer, centerX, centerY, placement) {
  doc.save();
  doc.translate(centerX, centerY);
  doc.rotate(placement.angle);
  doc.image(imageBuffer, -placement.size / 2, -placement.size / 2, {
    fit: [placement.size, placement.size],
    align: "center",
    valign: "center"
  });
  doc.restore();
}

function drawFrontCard(doc, deck, cardSymbols, centerX, centerY, cardIndex, imageCache) {
  drawCardBase(doc, centerX, centerY);

  const placements = buildCardPlacements(deck, cardIndex, cardSymbols);

  cardSymbols.forEach((symbol, index) => {
    const placement = placements[index];
    const imageBuffer = imageCache.get(symbol.id);
    drawSymbol(doc, imageBuffer, centerX + placement.x, centerY + placement.y, placement);
  });
}

function getCardLayout(deck, cardIndex, cardSymbols) {
  const placements = buildCardPlacements(deck, cardIndex, cardSymbols);

  return cardSymbols.map((symbol, index) => {
    const placement = placements[index];

    return {
      label: symbol.label,
      imageData: symbol.image_data || getPlaceholderImageDataUrl(),
      x: placement.x,
      y: placement.y,
      size: placement.size,
      angle: placement.angle,
      xRatio: placement.x / CARD_DIAMETER,
      yRatio: placement.y / CARD_DIAMETER,
      sizeRatio: placement.size / CARD_DIAMETER
    };
  });
}

function drawBackCard(doc, centerX, centerY, customBackBuffer, placeholderBuffer) {
  drawCardBase(doc, centerX, centerY);

  const innerRadius = CARD_RADIUS - 10;

  doc.save();
  doc.circle(centerX, centerY, innerRadius).clip();

  if (customBackBuffer) {
    // Fill the card circle with the user's image.
    doc.image(customBackBuffer, centerX - innerRadius, centerY - innerRadius, {
      fit: [innerRadius * 2, innerRadius * 2],
      align: "center",
      valign: "center"
    });
  } else {
    // Default design: purple fill, decorative rings, placeholder icon.
    doc.rect(centerX - innerRadius, centerY - innerRadius, innerRadius * 2, innerRadius * 2).fill("#6f3cff");

    doc.save();
    doc.lineWidth(5).circle(centerX, centerY, innerRadius * 0.78).stroke("#ffd84d");
    doc.lineWidth(3).circle(centerX, centerY, innerRadius * 0.60).stroke("#efe7ff");
    doc.restore();

    const iconSize = CARD_DIAMETER * 0.64;
    doc.image(placeholderBuffer, centerX - iconSize / 2, centerY - iconSize / 2, {
      fit: [iconSize, iconSize],
      align: "center",
      valign: "center"
    });
  }

  doc.restore();
}

function generateDeckPdf(deck, symbols, cards) {
  const doc = new PDFDocument({
    size: [A4.width, A4.height],
    margin: 0,
    autoFirstPage: false,
    info: {
      Title: `${deck.title} printable cards`,
      Author: "Dobble Generator"
    }
  });

  // Decode every unique symbol image exactly once up front.
  // createPlaceholderPngBuffer() returns a cached singleton buffer, so the
  // same Buffer reference is used for the image cache fallback AND the card
  // backs — PDFKit will embed it only once in the PDF.
  const placeholderBuffer = createPlaceholderPngBuffer();
  const imageCache = buildSymbolImageCache(symbols);

  // Decode the custom card back once if the deck has one set.
  let customBackBuffer = deck.card_back_image ? dataUrlToBuffer(deck.card_back_image) : null;
  if (customBackBuffer) {
    try {
      customBackBuffer = resizePngBuffer(customBackBuffer, MAX_CARD_BACK_PX);
    } catch (_) {
      customBackBuffer = null;
    }
  }

  const cardIndexes = buildSpotMatchIndexCards(deck.symbols_per_card).slice(0, deck.total_cards);
  const cardPages = chunk(cardIndexes, CARDS_PER_PAGE);

  cardPages.forEach((pageCards, pageIndex) => {
    doc.addPage();
    drawPageBackground(doc);

    pageCards.forEach((cardIndexesForOneCard, index) => {
      const slot = CARD_SLOTS[index];
      const cardSymbols = cardIndexesForOneCard.map((symbolIndex) => symbols[symbolIndex]).filter(Boolean);
      drawFrontCard(doc, deck, cardSymbols, slot.x, slot.y, pageIndex * CARDS_PER_PAGE + index, imageCache);
    });
  });

  doc.addPage();
  drawPageBackground(doc);

  CARD_SLOTS.forEach((slot) => {
    drawBackCard(doc, slot.x, slot.y, customBackBuffer, placeholderBuffer);
  });

  return doc;
}

module.exports = {
  generateDeckPdf,
  getCardLayout,
  buildCardPlacements
};
