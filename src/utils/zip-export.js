/**
 * ZIP export for SpotMatch decks.
 *
 * Renders each card face and the card back as a print-ready PNG at 300 DPI.
 * No decorative card borders are drawn — the circular artwork runs to the
 * bleed edge so the printer can cut to the circle shape.  The region outside
 * the circle is white.
 *
 * Returns an archiver ZIP stream.  The caller must pipe it to an output
 * stream and then call archive.finalize() to begin writing.
 *
 * PNG rendering is done entirely with pngjs (no native deps).  Symbol images
 * are composited onto the card canvas using an inverse-rotation pixel-scan so
 * they appear at the correct position, scale and angle — identical geometry
 * to the PDF export.
 */

"use strict";

const { PNG } = require("pngjs");
const archiver = require("archiver");
const { buildSpotMatchIndexCards } = require("./dobble");
const { buildCardPlacements } = require("./pdf-export");
const { createPlaceholderPngBuffer } = require("./placeholder");
const { resizePngBuffer } = require("./png");

// ── Constants ────────────────────────────────────────────────────────────────

// 85 mm card at 300 DPI
const DPI = 300;
const CARD_DIAMETER_PX = Math.round(85 * DPI / 25.4); // 1004 px
const CARD_RADIUS_PX = CARD_DIAMETER_PX / 2; // 502 px

// buildCardPlacements() returns coordinates in PDF points (72 pt/inch).
// Scale to pixels: 300 DPI / 72 pt-per-inch ≈ 4.167 px/pt.
const PT_TO_PX = DPI / 72;

const MAX_CARD_BACK_PX = 1024;

// ── Utilities ────────────────────────────────────────────────────────────────

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl).match(/^data:image\/png;base64,(.+)$/);
  return match ? Buffer.from(match[1], "base64") : null;
}

/**
 * Build a Map<symbolId, parsed-PNG-object> from the symbol array.
 * Each image is decoded once; the same object is reused for every card
 * that contains that symbol.
 */
// Images are already scaled to ≤512 px at upload time, so no resize is needed here.
function buildSymbolImageCache(symbols) {
  const placeholder = PNG.sync.read(createPlaceholderPngBuffer());
  const cache = new Map();

  for (const symbol of symbols) {
    if (!symbol) continue;

    const buffer = symbol.image_data ? dataUrlToBuffer(symbol.image_data) : null;

    cache.set(symbol.id, buffer ? PNG.sync.read(buffer) : placeholder);
  }

  return cache;
}

// ── Low-level pixel helpers ──────────────────────────────────────────────────

/**
 * Alpha-composite one RGBA pixel onto the canvas data buffer.
 * Uses the standard "source-over" formula.
 */
function blendPixel(data, canvasWidth, x, y, r, g, b, a) {
  const i = (y * canvasWidth + x) * 4;
  const srcA = a / 255;
  const dstA = data[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);

  if (outA <= 0) return;

  data[i]     = Math.round((r * srcA + data[i]     * dstA * (1 - srcA)) / outA);
  data[i + 1] = Math.round((g * srcA + data[i + 1] * dstA * (1 - srcA)) / outA);
  data[i + 2] = Math.round((b * srcA + data[i + 2] * dstA * (1 - srcA)) / outA);
  data[i + 3] = Math.round(outA * 255);
}

/**
 * Fill a disc (filled circle) with a solid colour using blendPixel.
 */
function fillCircle(data, canvasWidth, canvasHeight, cx, cy, radius, r, g, b, a) {
  const r2 = radius * radius;
  const minX = Math.max(0, Math.floor(cx - radius - 1));
  const maxX = Math.min(canvasWidth - 1, Math.ceil(cx + radius + 1));
  const minY = Math.max(0, Math.floor(cy - radius - 1));
  const maxY = Math.min(canvasHeight - 1, Math.ceil(cy + radius + 1));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        blendPixel(data, canvasWidth, x, y, r, g, b, a);
      }
    }
  }
}

/**
 * Draw an annulus (ring) by hard-setting pixels between innerRadius and
 * outerRadius to the given opaque colour.  Used for the card-back decorative
 * rings that sit on top of the purple fill.
 */
function drawRing(data, canvasWidth, canvasHeight, cx, cy, outerRadius, innerRadius, r, g, b) {
  const outerR2 = outerRadius * outerRadius;
  const innerR2 = innerRadius * innerRadius;
  const minX = Math.max(0, Math.floor(cx - outerRadius - 1));
  const maxX = Math.min(canvasWidth - 1, Math.ceil(cx + outerRadius + 1));
  const minY = Math.max(0, Math.floor(cy - outerRadius - 1));
  const maxY = Math.min(canvasHeight - 1, Math.ceil(cy + outerRadius + 1));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= outerR2 && d2 >= innerR2) {
        const i = (y * canvasWidth + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
  }
}

/**
 * Composite a source PNG image onto the canvas, centred at (symbolX, symbolY),
 * drawn to fit within a sizePx × sizePx box (maintaining aspect ratio), and
 * rotated clockwise by angleDeg degrees.
 *
 * Uses an inverse-rotation pixel scan: for every canvas pixel in the
 * axis-aligned bounding box of the rotated image, the corresponding source
 * pixel is looked up and alpha-composited.
 */
function compositeImage(data, canvasWidth, canvasHeight, srcPng, symbolX, symbolY, sizePx, angleDeg) {
  const angleRad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);

  // Compute the rendered dimensions that fit srcPng inside sizePx × sizePx
  // while maintaining aspect ratio (matches PDFKit's `fit` behaviour).
  const aspect = srcPng.width / srcPng.height;
  let drawW, drawH;

  if (aspect >= 1) {
    drawW = sizePx;
    drawH = sizePx / aspect;
  } else {
    drawH = sizePx;
    drawW = sizePx * aspect;
  }

  const halfDrawW = drawW / 2;
  const halfDrawH = drawH / 2;

  // Axis-aligned bounding box of the rotated sizePx × sizePx square.
  const halfDiag = (sizePx * Math.SQRT2) / 2;
  const minCX = Math.max(0, Math.floor(symbolX - halfDiag));
  const maxCX = Math.min(canvasWidth - 1, Math.ceil(symbolX + halfDiag));
  const minCY = Math.max(0, Math.floor(symbolY - halfDiag));
  const maxCY = Math.min(canvasHeight - 1, Math.ceil(symbolY + halfDiag));

  for (let cy = minCY; cy <= maxCY; cy += 1) {
    for (let cx = minCX; cx <= maxCX; cx += 1) {
      // Offset of this canvas pixel relative to the symbol centre.
      const rx = cx - symbolX;
      const ry = cy - symbolY;

      // Inverse rotation (clockwise angle → inverse is same angle back):
      // Forward:  x' = cos·x - sin·y,  y' = sin·x + cos·y
      // Inverse:  x  = cos·x' + sin·y', y  = −sin·x' + cos·y'
      const lx = cosA * rx + sinA * ry;
      const ly = -sinA * rx + cosA * ry;

      // Skip pixels outside the drawn content area.
      if (lx < -halfDrawW || lx > halfDrawW || ly < -halfDrawH || ly > halfDrawH) continue;

      // Map local coordinates to source image pixel indices.
      const imgX = Math.round(((lx / drawW) + 0.5) * (srcPng.width - 1));
      const imgY = Math.round(((ly / drawH) + 0.5) * (srcPng.height - 1));

      if (imgX < 0 || imgX >= srcPng.width || imgY < 0 || imgY >= srcPng.height) continue;

      const si = (imgY * srcPng.width + imgX) * 4;
      const srcAlpha = srcPng.data[si + 3];
      if (srcAlpha === 0) continue;

      blendPixel(data, canvasWidth, cx, cy,
        srcPng.data[si], srcPng.data[si + 1], srcPng.data[si + 2], srcAlpha);
    }
  }
}

/**
 * Set every pixel outside the card circle to opaque white.
 * Symbols that partially overlap the edge are cleanly trimmed.
 */
function applyCircularClip(data, canvasWidth, canvasHeight) {
  const cx = canvasWidth / 2;
  const cy = canvasHeight / 2;
  const r2 = cx * cx; // canvas is square, so cx === cy === radius

  for (let y = 0; y < canvasHeight; y += 1) {
    for (let x = 0; x < canvasWidth; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r2) {
        const i = (y * canvasWidth + x) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = 255;
      }
    }
  }
}

/** Create a fully white, opaque CARD_DIAMETER_PX × CARD_DIAMETER_PX canvas. */
function createWhiteCanvas() {
  const png = new PNG({ width: CARD_DIAMETER_PX, height: CARD_DIAMETER_PX });
  png.data.fill(255); // RGBA = (255,255,255,255) — white, fully opaque
  return png;
}

// ── Card renderers ───────────────────────────────────────────────────────────

/**
 * Render a single face card as a PNG buffer.
 * Symbols are placed using the same deterministic layout as the PDF export.
 */
function renderFrontCard(deck, cardSymbols, cardIndex, imageCache) {
  const png = createWhiteCanvas();
  const { data } = png;
  const cx = CARD_RADIUS_PX;
  const cy = CARD_RADIUS_PX;

  const placements = buildCardPlacements(deck, cardIndex, cardSymbols);

  cardSymbols.forEach((symbol, index) => {
    const placement = placements[index];
    const srcPng = imageCache.get(symbol.id);
    if (!srcPng) return;

    // Convert PDF-point coordinates to pixels.
    compositeImage(
      data, CARD_DIAMETER_PX, CARD_DIAMETER_PX,
      srcPng,
      cx + placement.x * PT_TO_PX,
      cy + placement.y * PT_TO_PX,
      placement.size * PT_TO_PX,
      placement.angle
    );
  });

  // Trim any symbol pixels that overflow the circle boundary.
  applyCircularClip(data, CARD_DIAMETER_PX, CARD_DIAMETER_PX);

  return PNG.sync.write(png, { colorType: 6 });
}

/**
 * Render the card back as a PNG buffer.
 *
 * If the deck has a custom card back image it is scaled to fill the card
 * circle.  Otherwise the default design (purple fill + decorative rings +
 * placeholder icon) is drawn.
 *
 * No border strokes are added — the circle content runs to the bleed edge.
 */
function renderBackCard(customBackBuffer) {
  const png = createWhiteCanvas();
  const { data } = png;
  const cx = CARD_RADIUS_PX;
  const cy = CARD_RADIUS_PX;

  if (customBackBuffer) {
    // Scale the custom image to fill the full card circle.
    const srcPng = PNG.sync.read(customBackBuffer);
    compositeImage(data, CARD_DIAMETER_PX, CARD_DIAMETER_PX,
      srcPng, cx, cy, CARD_DIAMETER_PX, 0);
  } else {
    // Default design: purple fill + golden outer ring + light-purple inner ring
    // + centred placeholder icon.

    // Purple fill (#6f3cff).
    fillCircle(data, CARD_DIAMETER_PX, CARD_DIAMETER_PX,
      cx, cy, CARD_RADIUS_PX, 0x6f, 0x3c, 0xff, 255);

    // Outer decorative ring — golden #ffd84d, ~5 pt wide in the PDF.
    const ring1Outer = Math.round(CARD_RADIUS_PX * 0.78);
    const ring1Width = Math.round(5 * PT_TO_PX);
    drawRing(data, CARD_DIAMETER_PX, CARD_DIAMETER_PX,
      cx, cy, ring1Outer, ring1Outer - ring1Width, 0xff, 0xd8, 0x4d);

    // Inner decorative ring — light purple #efe7ff, ~3 pt wide.
    const ring2Outer = Math.round(CARD_RADIUS_PX * 0.60);
    const ring2Width = Math.round(3 * PT_TO_PX);
    drawRing(data, CARD_DIAMETER_PX, CARD_DIAMETER_PX,
      cx, cy, ring2Outer, ring2Outer - ring2Width, 0xef, 0xe7, 0xff);

    // Centred placeholder icon (sized as in the PDF: CARD_DIAMETER × 0.64).
    const iconSizePx = Math.round(CARD_DIAMETER_PX * 0.64);
    const placeholderPng = PNG.sync.read(createPlaceholderPngBuffer());
    compositeImage(data, CARD_DIAMETER_PX, CARD_DIAMETER_PX,
      placeholderPng, cx, cy, iconSizePx, 0);
  }

  applyCircularClip(data, CARD_DIAMETER_PX, CARD_DIAMETER_PX);

  return PNG.sync.write(png, { colorType: 6 });
}

// ── Main export function ─────────────────────────────────────────────────────

/**
 * Build and return an archiver ZIP stream containing one PNG per card face
 * plus one card-back PNG.
 *
 * The caller is responsible for:
 *   1. Piping the returned archive to an output stream.
 *   2. Calling archive.finalize() to begin writing.
 *
 * PNGs are already deflate-compressed, so the ZIP uses STORE (level 0) to
 * avoid wasting CPU on a second round of compression.
 */
function generateDeckZip(deck, symbols) {
  const cardIndexes = buildSpotMatchIndexCards(deck.symbols_per_card).slice(0, deck.total_cards);
  const imageCache = buildSymbolImageCache(symbols);

  let customBackBuffer = deck.card_back_image ? dataUrlToBuffer(deck.card_back_image) : null;
  if (customBackBuffer) {
    try {
      customBackBuffer = resizePngBuffer(customBackBuffer, MAX_CARD_BACK_PX);
    } catch (_) {
      customBackBuffer = null;
    }
  }

  // STORE (level 0): PNGs are already DEFLATE-compressed internally, so a
  // second pass gains nothing and only wastes CPU time.
  const archive = archiver("zip", { zlib: { level: 0 } });

  // Single card-back image.
  archive.append(renderBackCard(customBackBuffer), { name: "card-back.png" });

  // One image per unique card face.
  const padLen = String(cardIndexes.length).length;
  cardIndexes.forEach((cardSymbolIndexes, i) => {
    const cardSymbols = cardSymbolIndexes.map((idx) => symbols[idx]).filter(Boolean);
    const cardPng = renderFrontCard(deck, cardSymbols, i, imageCache);
    const cardNum = String(i + 1).padStart(padLen, "0");
    archive.append(cardPng, { name: `card-${cardNum}.png` });
  });

  return archive;
}

module.exports = { generateDeckZip };
