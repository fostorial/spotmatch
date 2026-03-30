const { PNG } = require("pngjs");

const SIZE = 256;
let cachedPngBuffer = null;
let cachedDataUrl = null;

function blendPixel(buffer, x, y, rgba) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) {
    return;
  }

  const index = (y * SIZE + x) * 4;
  const [sr, sg, sb, sa] = rgba;
  const dr = buffer[index];
  const dg = buffer[index + 1];
  const db = buffer[index + 2];
  const da = buffer[index + 3];
  const srcAlpha = sa / 255;
  const dstAlpha = da / 255;
  const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha);

  if (outAlpha <= 0) {
    return;
  }

  buffer[index] = Math.round((sr * srcAlpha + dr * dstAlpha * (1 - srcAlpha)) / outAlpha);
  buffer[index + 1] = Math.round((sg * srcAlpha + dg * dstAlpha * (1 - srcAlpha)) / outAlpha);
  buffer[index + 2] = Math.round((sb * srcAlpha + db * dstAlpha * (1 - srcAlpha)) / outAlpha);
  buffer[index + 3] = Math.round(outAlpha * 255);
}

function fillCircle(buffer, cx, cy, radius, color) {
  const minX = Math.max(0, Math.floor(cx - radius - 1));
  const maxX = Math.min(SIZE - 1, Math.ceil(cx + radius + 1));
  const minY = Math.max(0, Math.floor(cy - radius - 1));
  const maxY = Math.min(SIZE - 1, Math.ceil(cy + radius + 1));
  const radiusSquared = radius * radius;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radiusSquared) {
        blendPixel(buffer, x, y, color);
      }
    }
  }
}

function strokeCircle(buffer, cx, cy, radius, width, color) {
  fillCircle(buffer, cx, cy, radius, color);
  fillCircle(buffer, cx, cy, radius - width, [0, 0, 0, 0]);
}

function strokeLine(buffer, x1, y1, x2, y2, width, color) {
  const steps = Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)));
  for (let step = 0; step <= steps; step += 1) {
    const t = steps === 0 ? 0 : step / steps;
    fillCircle(buffer, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, color);
  }
}

function createPlaceholderPngBuffer() {
  if (cachedPngBuffer) {
    return cachedPngBuffer;
  }

  const png = new PNG({ width: SIZE, height: SIZE });
  png.data.fill(0);

  fillCircle(png.data, 128, 128, 84, [255, 243, 191, 255]);
  strokeCircle(png.data, 128, 128, 84, 8, [111, 60, 255, 255]);
  strokeCircle(png.data, 128, 128, 60, 4, [255, 216, 77, 255]);
  strokeLine(png.data, 128, 86, 128, 138, 10, [111, 60, 255, 255]);
  fillCircle(png.data, 128, 166, 12, [111, 60, 255, 255]);

  const sparkleOffsets = [
    [58, 58],
    [198, 58],
    [58, 198],
    [198, 198]
  ];

  sparkleOffsets.forEach(([x, y], index) => {
    fillCircle(png.data, x, y, 14, index % 2 === 0 ? [255, 216, 77, 255] : [111, 60, 255, 255]);
  });

  cachedPngBuffer = PNG.sync.write(png);
  return cachedPngBuffer;
}

function getPlaceholderImageDataUrl() {
  if (!cachedDataUrl) {
    cachedDataUrl = `data:image/png;base64,${createPlaceholderPngBuffer().toString("base64")}`;
  }

  return cachedDataUrl;
}

module.exports = {
  createPlaceholderPngBuffer,
  getPlaceholderImageDataUrl
};
