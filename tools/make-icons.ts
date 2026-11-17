/**
 * Gera os ícones PNG do app (instalação no celular) a partir do logo vetorial.
 * Uso: node tools/make-icons.ts
 * Sem dependências: rasteriza com supersampling e escreve PNG via zlib.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'img');

const DARK: RGB = [0x09, 0x09, 0x09];
const WHITE: RGB = [0xff, 0xff, 0xff];
const NEON: RGB = [0x8d, 0x9c, 0x04];   // borda da marca (amarelo neon sobre o fundo escuro)
type RGB = [number, number, number];

// Logo da VAIRO ("V" com estrada): contornos em tools/logo-shape.json, numa caixa 0..100.
// O mesmo desenho está em LOGO_MARK (public/js/common.js) e em public/img/icon.svg.
const SHAPE: [number, number][][] = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'logo-shape.json'), 'utf8'),
).polys;
const BOXES = SHAPE.map(poly => poly.reduce(
  (b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
  [Infinity, Infinity, -Infinity, -Infinity]));

function inPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** true se o pixel faz parte da marca. `scale` é a fração do ícone ocupada pela caixa do desenho. */
function markInk(x: number, y: number, scale: number): boolean {
  const u = ((x - 0.5) / scale + 0.5) * 100;
  const v = ((y - 0.5) / scale + 0.5) * 100;
  let inside = false;   // regra par-ímpar entre os contornos
  for (let k = 0; k < SHAPE.length; k++) {
    const b = BOXES[k];
    if (u < b[0] || u > b[2] || v < b[1] || v > b[3]) continue;
    if (inPolygon(u, v, SHAPE[k])) inside = !inside;
  }
  return inside;
}

/** distância (normalizada) do ponto até a borda do badge arredondado; negativa = dentro. */
function badgeEdge(x: number, y: number): number {
  const r = 0.22;
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return Math.hypot(dx, dy) - r;
}

/** true se o pixel pertence ao fundo (badge arredondado ou quadrado cheio). */
function inBackground(x: number, y: number, fullBleed: boolean): boolean {
  return fullBleed || badgeEdge(x, y) <= 0;
}

function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file: string, size: number, rgba: Buffer): void {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtro "none"
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  console.log(`  ✓ ${path.basename(file)} (${size}×${size}, ${(png.length / 1024).toFixed(1)} KB)`);
}

/** Renderiza com supersampling 4× para bordas suaves. */
function render(size: number, fullBleed: boolean): Buffer {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  // no modo maskable o conteúdo fica dentro da zona segura (80%)
  const logoScale = fullBleed ? 0.56 : 0.66;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (x + (sx + 0.5) / SS) / size;
          const ny = (y + (sy + 0.5) / SS) / size;
          let px: RGB | null = null;
          if (inBackground(nx, ny, fullBleed)) {
            // borda neon só no ícone com cantos próprios (o maskable é recortado pelo sistema)
            if (!fullBleed && badgeEdge(nx, ny) > -0.02) px = NEON;
            else px = markInk(nx, ny, logoScale) ? WHITE : DARK;
          }
          if (px) { r += px[0]; g += px[1]; b += px[2]; a += 255; }
        }
      }
      const n = SS * SS, i = (y * size + x) * 4;
      // pré-multiplicação reversa: cor média apenas dos subpixels opacos
      const opaque = a / 255;
      out[i] = opaque ? Math.round(r / opaque) : 0;
      out[i + 1] = opaque ? Math.round(g / opaque) : 0;
      out[i + 2] = opaque ? Math.round(b / opaque) : 0;
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
console.log('Gerando ícones da VAIRO…');
for (const [name, size, full] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['apple-touch-icon.png', 180, true],
  ['icon-maskable-512.png', 512, true],
] as [string, number, boolean][]) {
  writePng(path.join(OUT, name), size, render(size, full));
}
console.log('Pronto.');
