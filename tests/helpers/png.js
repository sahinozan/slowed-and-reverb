'use strict';

// Just enough of a PNG decoder to read the alpha channel of the 8-bit RGBA,
// non-interlaced icons that scripts/render-icons.js writes. Node's zlib does the
// inflating, so no image library is needed.

const { Buffer } = require('buffer');
const zlib = require('zlib');

function decodeRgba(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const [depth, colorType, , , interlace] = png.subarray(24, 29);
  if (depth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`expected 8-bit RGBA, non-interlaced; got depth ${depth}, color type ${colorType}, interlace ${interlace}`);
  }

  const data = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') data.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }

  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const [a, b, c] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
        predictor = a <= b && a <= c ? left : b <= c ? up : upLeft;
      }
      pixels[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  return { width, height, alpha: (x, y) => pixels[(y * width + x) * 4 + 3] };
}

// The smallest box holding every pixel that isn't fully transparent.
function visibleBounds(png) {
  const image = decodeRgba(png);
  let [left, top, right, bottom] = [image.width, image.height, -1, -1];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.alpha(x, y) === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

module.exports = { decodeRgba, visibleBounds };
