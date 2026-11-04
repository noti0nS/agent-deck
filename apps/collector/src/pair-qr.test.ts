import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
const jsQR = createRequire(import.meta.url)('jsqr') as (pixels: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
import { renderAsciiQr } from './pair.js';

it.each([
  'http://192.168.1.23:4100?code=ABCD-2345',
  'https://workstation.example-tailnet.ts.net:8444?code=ABCD-2345'
])('terminal QR decodes to %s', (url) => {
  const rows = renderAsciiQr(url).split('\n').map(row => row.replace(/\x1b\[[0-9;]*m/g, ''));
  const scale = 8;
  const width = rows[0].length * scale;
  const height = rows.length * 2 * scale;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const moduleY = Math.floor(y / scale);
      const char = rows[Math.floor(moduleY / 2)][Math.floor(x / scale)];
      const dark = char === '\u2588' || (moduleY % 2 === 0 ? char === '\u2580' : char === '\u2584');
      const offset = (y * width + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = dark ? 0 : 255;
      pixels[offset + 3] = 255;
    }
  }
  expect(jsQR(pixels, width, height)?.data).toBe(url);
});
