// Gera as molduras (PNG com a janela da foto transparente), o frames.json
// com as coordenadas dessa janela e a imagem de exemplo do site.
// Roda uma vez, localmente, e o resultado é versionado — a Lambda só
// compõe PNG + foto, sem precisar de fonte nem rasterizador de SVG.
//
//   npm run frames
//
// Identidade visual: template oficial do AWS Student Builder Group (fundo
// #161D26, grade de 120 px, mosaico em pixel, ícone do chip). As fontes do
// template (Amazon Ember) não são livres; o substituto indicado é JetBrains
// Mono nos títulos e Manrope no texto (licença OFL, baixadas do Google Fonts
// para um cache local ignorado pelo git).
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { Jimp } from 'jimp';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'services', 'assets');
const CACHE = join(ROOT, 'scripts', '.cache');
mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });

const TITLE = 'O que é arquitetura Serverless?';
const GROUP = 'AWS Student Builder Group IMT';
const DATE = '14/11/2026';

// Paleta do tema do template SBG.
const C = { bg: '#161D26', grid: '#656871', orange: '#FF9900', purple: '#AC5BFF', magenta: '#FF57E9', mint: '#00E582', blue: '#41B3FF', white: '#FFFFFF' };
const CELL = 120;

// Ícone do chip do programa (path do `chip-*.svg` do template, caixa 47.9..127.9).
const CHIP = 'M109.971 109.843 109.971 127.351 101.018 127.351 101.018 118.453 92.3538 118.453 92.3538 127.351 83.4006 127.351 83.4006 118.453 74.7366 118.453 74.7366 127.351 65.7834 127.351 65.7834 109.843 109.971 109.843ZM127.877 74.5371 118.924 74.5371 118.924 83.4355 127.877 83.4355 127.877 92.333 118.924 92.333 118.924 100.942 127.877 100.942 127.877 109.841 118.924 109.841 118.924 109.842 109.971 109.842 109.971 65.6396 127.877 65.6396 127.877 74.5371ZM65.7834 109.841 47.8772 109.841 47.8772 100.942 57.1194 100.942 57.1194 92.333 47.8772 92.333 47.8772 83.4355 57.1194 83.4355 57.1194 74.5371 47.8772 74.5371 47.8772 65.6396 65.7834 65.6396 65.7834 109.841ZM74.7366 57.0303 83.4006 57.0303 83.4006 48.1318 92.3538 48.1318 92.3538 57.0303 101.018 57.0303 101.018 48.1318 109.971 48.1318 109.971 65.6406 65.7834 65.6406 65.7834 48.1318 74.7366 48.1318 74.7366 57.0303Z';
const chip = (x, y, size, color) =>
  `<path d="${CHIP}" fill="${color}" transform="translate(${x} ${y}) scale(${size / 80}) translate(-47.877 -48.132)"/>`;

async function font(family, weight) {
  const file = join(CACHE, `${family.replace(/ /g, '')}-${weight}.ttf`);
  if (!existsSync(file)) {
    // User-agent antigo faz o Google Fonts responder com TTF em vez de woff2.
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:wght@${weight}`, {
      headers: { 'user-agent': 'Mozilla/4.0' },
    })).text();
    const url = /url\((https:[^)]+\.ttf)\)/.exec(css)?.[1];
    if (!url) throw new Error(`TTF não encontrado para ${family} ${weight}`);
    writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
  }
  return file;
}

const fontFiles = await Promise.all([font('JetBrains Mono', 700), font('Manrope', 600), font('Manrope', 800)]);

function render(svg, width) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Manrope' },
  }).render().asPng();
}

// Grade de 120 px, como no template.
function grid(width, height) {
  const lines = [];
  for (let x = CELL; x < width; x += CELL) lines.push(`M${x} 0V${height}`);
  for (let y = CELL; y < height; y += CELL) lines.push(`M0 ${y}H${width}`);
  return `<path d="${lines.join('')}" stroke="${C.grid}" stroke-width="1.5" opacity="0.55"/>`;
}

// Mosaico em pixel: células coloridas escolhidas por um gerador com semente
// fixa (mesmo resultado a cada build), só nas células permitidas.
function mosaic(cells, density = 0.45, seed = 7) {
  const colors = [C.orange, C.purple, C.magenta, C.mint, C.blue];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return cells
    .filter(() => rnd() < density)
    .map(([c, r]) => `<rect x="${c * CELL}" y="${r * CELL}" width="${CELL}" height="${CELL}" fill="${colors[Math.floor(rnd() * colors.length)]}"/>`)
    .join('');
}

const cellsWhere = (cols, rows, keep) => {
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (keep(c, r)) out.push([c, r]);
  return out;
};

// Tudo é desenhado dentro de um <mask> que recorta a janela da foto.
function frameSvg({ width, height, win, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><mask id="hole"><rect width="${width}" height="${height}" fill="#fff"/><rect x="${win.x}" y="${win.y}" width="${win.w}" height="${win.h}" fill="#000"/></mask></defs>
  <g mask="url(#hole)">
    <rect width="${width}" height="${height}" fill="${C.bg}"/>
    ${grid(width, height)}
    ${body}
    <rect x="${win.x - 10}" y="${win.y - 10}" width="${win.w + 20}" height="${win.h + 20}" fill="${C.white}"/>
  </g>
</svg>`;
}

const frames = {};

// Story 1080x1920 = 9x16 células. Foto em 7x9 células; o conteúdo-chave fica
// fora das faixas de ~250 px no topo e na base, onde o Instagram desenha a interface.
{
  const width = 1080, height = 1920;
  const win = { x: 120, y: 360, w: 840, h: 1080 };
  const body = `
    ${mosaic(cellsWhere(9, 16, (c, r) => (r <= 1 || r >= 14 || c === 0 || c === 8) && !(r === 2 && c === 0)), 0.42, 11)}
    ${chip(120, 240, 96, C.white)}
    <text x="240" y="303" font-family="JetBrains Mono" font-weight="700" font-size="30" fill="${C.white}">${GROUP}</text>
    <text x="540" y="1532" text-anchor="middle" font-family="JetBrains Mono" font-weight="700" font-size="40" fill="${C.white}">${TITLE}</text>
    <text x="540" y="1594" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="34" fill="${C.orange}">${DATE} · Sua lembrança serverless</text>`;
  writeFileSync(join(OUT, 'frame-story.png'), render(frameSvg({ width, height, win, body }), width));
  frames.story = { width, height, window: win };
}

// Cartão quadrado 1080x1080 = 9x9 células. Foto em 7x6 células.
{
  const width = 1080, height = 1080;
  const win = { x: 120, y: 120, w: 840, h: 720 };
  const body = `
    ${mosaic(cellsWhere(9, 9, (c, r) => (r === 0 || c === 0 || c === 8) && !(c === 0 && r === 0)), 0.5, 5)}
    ${chip(12, 12, 96, C.white)}
    <text x="540" y="920" text-anchor="middle" font-family="JetBrains Mono" font-weight="700" font-size="40" fill="${C.white}">${TITLE}</text>
    <text x="540" y="978" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="30" fill="${C.orange}">${GROUP} · ${DATE}</text>`;
  writeFileSync(join(OUT, 'frame-square.png'), render(frameSvg({ width, height, win, body }), width));
  frames.square = { width, height, window: win };
}

writeFileSync(join(OUT, 'frames.json'), JSON.stringify(frames, null, 2) + '\n');

// Imagem de exemplo (ilustração própria, sem rosto) para quem não quiser
// enviar selfie — também usada pela carga sintética do painel admin.
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500">
    <rect width="1200" height="1500" fill="${C.purple}"/>
    <path d="${Array.from({ length: 9 }, (_, i) => `M${(i + 1) * 120} 0V1500`).join('')}${Array.from({ length: 12 }, (_, i) => `M0 ${(i + 1) * 120}H1200`).join('')}" stroke="#fff" stroke-width="2" opacity="0.18"/>
    <g fill="#fff">
      <circle cx="430" cy="760" r="170"/><circle cx="640" cy="660" r="220"/><circle cx="830" cy="790" r="150"/>
      <rect x="300" y="760" width="660" height="180" rx="90"/>
    </g>
    ${chip(560, 700, 140, C.purple)}
    <text x="600" y="1180" text-anchor="middle" font-family="JetBrains Mono" font-weight="700" font-size="60" fill="#fff">imagem de exemplo</text>
  </svg>`;
  const png = render(svg, 1200);
  const img = await Jimp.fromBuffer(png);
  writeFileSync(join(ROOT, 'web', 'sample.jpg'), await img.getBuffer('image/jpeg', { quality: 85 }));
}

console.log('frames:', JSON.stringify(frames));
