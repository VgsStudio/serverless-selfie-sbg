// Gera as molduras (PNG com a janela da foto transparente), o frames.json
// com as coordenadas dessa janela e a imagem de exemplo do site.
// Roda uma vez, localmente, e o resultado é versionado — a Lambda só
// compõe PNG + foto, sem precisar de fonte nem rasterizador de SVG.
//
//   npm run frames
//
// Fontes (Sora, Manrope — licença OFL) baixadas do Google Fonts para um
// cache local ignorado pelo git.
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

// Textos da moldura. A arte oficial do grupo ainda não foi autorizada:
// quando chegar, entra no SVG abaixo (ver README, "Trocar a arte").
const TITLE = 'O que é arquitetura Serverless?';
const GROUP = 'Student Builder Group IMT';
const DATE = '14/11/2026';
const TAGLINE = 'Sua lembrança serverless λ';

const C = { dark: '#1A0F3D', purple: '#655CC6', blue: '#5BBEED', green: '#A4DF64', orange: '#F59D01', soft: '#F6F5FB' };

async function font(family, weight) {
  const file = join(CACHE, `${family}-${weight}.ttf`);
  if (!existsSync(file)) {
    // User-agent antigo faz o Google Fonts responder com TTF em vez de woff2.
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${family}:wght@${weight}`, {
      headers: { 'user-agent': 'Mozilla/4.0' },
    })).text();
    const url = /url\((https:[^)]+\.ttf)\)/.exec(css)?.[1];
    if (!url) throw new Error(`TTF não encontrado para ${family} ${weight}`);
    writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
  }
  return file;
}

const fontFiles = await Promise.all([font('Sora', 700), font('Manrope', 600), font('Manrope', 800)]);

function render(svg, width) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Manrope' },
  }).render().asPng();
}

const stripe = (x, y, w, h) => {
  const seg = w / 4;
  return [C.purple, C.blue, C.green, C.orange]
    .map((c, i) => `<rect x="${x + i * seg}" y="${y}" width="${seg}" height="${h}" fill="${c}"/>`)
    .join('');
};

// Tudo é desenhado dentro de um <mask> que recorta a janela da foto.
function frameSvg({ width, height, win, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <mask id="hole"><rect width="${width}" height="${height}" fill="#fff"/><rect x="${win.x}" y="${win.y}" width="${win.w}" height="${win.h}" fill="#000"/></mask>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${C.dark}"/><stop offset="1" stop-color="#2E1F73"/></linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.35"/></filter>
  </defs>
  <g mask="url(#hole)">${body}</g>
</svg>`;
}

const frames = {};

// Story 1080x1920 — conteúdo-chave fora das faixas de ~250px no topo e na base,
// onde o Instagram desenha a própria interface.
{
  const width = 1080, height = 1920;
  const card = { x: 110, y: 290, w: 860, h: 1230 };
  const win = { x: 150, y: 330, w: 780, h: 975 }; // 4:5
  const body = `
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <circle cx="930" cy="190" r="260" fill="${C.purple}" opacity="0.35"/>
    <circle cx="120" cy="1760" r="300" fill="${C.blue}" opacity="0.18"/>
    <rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="10" fill="#fff" filter="url(#shadow)"/>
    <text x="540" y="1393" text-anchor="middle" font-family="Sora" font-weight="700" font-size="40" fill="${C.dark}">${TITLE}</text>
    <text x="540" y="1449" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="30" fill="${C.purple}">${GROUP} · ${DATE}</text>
    ${stripe(card.x + 40, 1480, card.w - 80, 8)}
    <text x="540" y="1610" text-anchor="middle" font-family="Manrope" font-weight="600" font-size="34" fill="#fff" opacity="0.85">${TAGLINE}</text>`;
  writeFileSync(join(OUT, 'frame-story.png'), render(frameSvg({ width, height, win, body }), width));
  frames.story = { width, height, window: win };
}

// Cartão quadrado 1080x1080.
{
  const width = 1080, height = 1080;
  const win = { x: 90, y: 80, w: 900, h: 760 };
  const body = `
    <rect width="${width}" height="${height}" fill="${C.soft}"/>
    <rect x="50" y="40" width="980" height="1000" rx="10" fill="#fff" filter="url(#shadow)"/>
    <text x="540" y="922" text-anchor="middle" font-family="Sora" font-weight="700" font-size="44" fill="${C.dark}">${TITLE}</text>
    <text x="540" y="978" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="30" fill="${C.purple}">${GROUP} · ${DATE}</text>
    ${stripe(90, 1004, 900, 8)}`;
  writeFileSync(join(OUT, 'frame-square.png'), render(frameSvg({ width, height, win, body }), width));
  frames.square = { width, height, window: win };
}

writeFileSync(join(OUT, 'frames.json'), JSON.stringify(frames, null, 2) + '\n');

// Imagem de exemplo (ilustração própria, sem rosto) para quem não quiser
// enviar selfie — também usada pela carga sintética do painel admin.
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.blue}"/><stop offset="1" stop-color="${C.purple}"/></linearGradient></defs>
    <rect width="1200" height="1500" fill="url(#g)"/>
    <g fill="#fff">
      <circle cx="430" cy="760" r="170"/><circle cx="640" cy="660" r="220"/><circle cx="830" cy="790" r="150"/>
      <rect x="300" y="760" width="660" height="180" rx="90"/>
    </g>
    <text x="610" y="880" text-anchor="middle" font-family="Sora" font-weight="700" font-size="260" fill="${C.purple}">λ</text>
    <text x="600" y="1180" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="64" fill="#fff">imagem de exemplo</text>
  </svg>`;
  const png = render(svg, 1200);
  const img = await Jimp.fromBuffer(png);
  writeFileSync(join(ROOT, 'web', 'sample.jpg'), await img.getBuffer('image/jpeg', { quality: 85 }));
}

console.log('frames:', JSON.stringify(frames));
console.log('ok:', readFileSync(join(OUT, 'frames.json'), 'utf8').length, 'bytes de frames.json');
