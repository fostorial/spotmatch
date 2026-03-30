const { PNG } = require("pngjs");

function isPngBuffer(buffer) {
  if (!buffer || buffer.length < 8) {
    return false;
  }

  return (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

function normalizePngBuffer(buffer) {
  if (!isPngBuffer(buffer)) {
    throw new Error("Uploaded file is not a valid PNG.");
  }

  const png = PNG.sync.read(buffer, {
    checkCRC: true
  });

  return PNG.sync.write(png, {
    colorType: 6,
    inputColorType: 6
  });
}

/**
 * Downscale a PNG buffer so its longest edge is at most maxDimension pixels,
 * preserving aspect ratio.  Returns the original buffer unchanged when it is
 * already within the limit.
 *
 * Nearest-neighbour sampling is used — fast and perfectly adequate for
 * downscaling symbol artwork destined for a ~30 mm card slot at 300 DPI
 * (~355 px).  Keeping images at ≤512 px caps the decoded RGBA memory at
 * ~1 MB per symbol (vs. potentially 30+ MB for a 3 MB uploaded PNG), which
 * prevents the PDF-generation child process from being OOM-killed.
 */
function resizePngBuffer(inputBuffer, maxDimension) {
  const src = PNG.sync.read(inputBuffer);

  if (src.width <= maxDimension && src.height <= maxDimension) {
    return inputBuffer;
  }

  const scale = maxDimension / Math.max(src.width, src.height);
  const dstWidth = Math.max(1, Math.round(src.width * scale));
  const dstHeight = Math.max(1, Math.round(src.height * scale));
  const dst = new PNG({ width: dstWidth, height: dstHeight });

  for (let dy = 0; dy < dstHeight; dy += 1) {
    for (let dx = 0; dx < dstWidth; dx += 1) {
      const sx = Math.min(Math.round(dx / scale), src.width - 1);
      const sy = Math.min(Math.round(dy / scale), src.height - 1);
      const si = (sy * src.width + sx) * 4;
      const di = (dy * dstWidth + dx) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }

  return PNG.sync.write(dst, { colorType: 6 });
}

module.exports = {
  isPngBuffer,
  normalizePngBuffer,
  resizePngBuffer
};
