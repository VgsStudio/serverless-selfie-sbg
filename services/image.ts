// Validação e composição da imagem. Puro (sem AWS) para ser testável.
// Jimp é JavaScript puro: nada de binário nativo para empacotar na Lambda.
import { Jimp } from 'jimp';
import frames from './assets/frames.json' with { type: 'json' };

export type Format = keyof typeof frames;
export const FORMATS = Object.keys(frames) as Format[];

/** Erro definitivo: o Step Functions NÃO repete (ver Retry no CDK). */
export class InvalidImage extends Error {
  override name = 'InvalidImage';
}

export interface Sniffed {
  type: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Lê tipo real e dimensões pelo cabeçalho, sem decodificar a imagem —
 *  o MIME informado pelo navegador não vale como prova. */
export function sniff(buf: Uint8Array): Sniffed | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('latin1', 12, 16) === 'IHDR') {
    return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; } // byte de preenchimento
      if (SOF.has(marker)) return { type: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

export function validate(head: Uint8Array, maxPixels: number): Sniffed {
  const s = sniff(head);
  if (!s) throw new InvalidImage('formato não suportado (use JPEG ou PNG)');
  if (s.width < 64 || s.height < 64) throw new InvalidImage('imagem pequena demais');
  if (s.width * s.height > maxPixels) throw new InvalidImage('resolução acima do limite');
  return s;
}

/** Recorte com a proporção da janela. fx/fy (0..1) seguem a mesma regra do
 *  `object-position` do CSS usado na pré-visualização do site. */
export function cropRect(srcW: number, srcH: number, winW: number, winH: number, fx = 0.5, fy = 0.5) {
  const aspect = winW / winH;
  const w = srcW / srcH > aspect ? Math.round(srcH * aspect) : srcW;
  const h = srcW / srcH > aspect ? srcH : Math.round(srcW / aspect);
  const clamp = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));
  return { x: Math.round((srcW - w) * clamp(fx)), y: Math.round((srcH - h) * clamp(fy)), w, h };
}

/** Orienta pelo EXIF (o Jimp faz na leitura), recorta, aplica a moldura e
 *  exporta JPEG — reencodar descarta EXIF/GPS da foto original. */
export async function render(input: Buffer, format: Format, frame: Buffer, focus = { x: 0.5, y: 0.5 }): Promise<Buffer> {
  const spec = frames[format];
  let photo;
  try {
    photo = await Jimp.fromBuffer(input);
  } catch {
    throw new InvalidImage('não foi possível decodificar a imagem');
  }
  const win = spec.window;
  const r = cropRect(photo.bitmap.width, photo.bitmap.height, win.w, win.h, focus.x, focus.y);
  photo.crop({ x: r.x, y: r.y, w: r.w, h: r.h }).resize({ w: win.w, h: win.h });

  const canvas = new Jimp({ width: spec.width, height: spec.height, color: 0x1a0f3dff });
  canvas.composite(photo, win.x, win.y);
  canvas.composite(await Jimp.fromBuffer(frame), 0, 0);
  return canvas.getBuffer('image/jpeg', { quality: 88 });
}
