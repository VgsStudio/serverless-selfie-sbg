import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Jimp } from 'jimp';
import { InvalidImage, cropRect, render, sniff, validate } from '../services/image.ts';
import { effectiveStatus } from '../services/common.ts';

const sample = readFileSync(new URL('../web/sample.jpg', import.meta.url));
const frame = (f: string) => readFileSync(new URL(`../services/assets/frame-${f}.png`, import.meta.url));

test('sniff lê tipo e dimensões reais de JPEG e PNG', async () => {
  assert.deepEqual(sniff(sample), { type: 'image/jpeg', width: 1200, height: 1500 });
  const png = await new Jimp({ width: 300, height: 200, color: 0xff0000ff }).getBuffer('image/png');
  assert.deepEqual(sniff(png), { type: 'image/png', width: 300, height: 200 });
});

test('validate rejeita tipo disfarçado, imagem minúscula e resolução excessiva', async () => {
  assert.throws(() => validate(Buffer.from('<svg>não sou jpeg</svg>'), 20e6), InvalidImage);
  const tiny = await new Jimp({ width: 10, height: 10, color: 0 }).getBuffer('image/png');
  assert.throws(() => validate(tiny, 20e6), /pequena/);
  assert.throws(() => validate(sample, 1_000_000), /resolução/);
  assert.equal(validate(sample, 20e6).type, 'image/jpeg');
});

test('cropRect mantém a proporção da janela e respeita o enquadramento', () => {
  // foto paisagem 2000x1000 numa janela 4:5 → recorte 800x1000
  assert.deepEqual(cropRect(2000, 1000, 780, 975, 0.5, 0.5), { x: 600, y: 0, w: 800, h: 1000 });
  assert.deepEqual(cropRect(2000, 1000, 780, 975, 0, 0.5), { x: 0, y: 0, w: 800, h: 1000 });
  assert.deepEqual(cropRect(2000, 1000, 780, 975, 1, 0.5), { x: 1200, y: 0, w: 800, h: 1000 });
  // foto retrato numa janela larga → corta em altura; foco inválido volta ao centro
  assert.deepEqual(cropRect(1000, 2000, 900, 760, NaN, 0), { x: 0, y: 0, w: 1000, h: 844 });
});

test('render gera Story 1080x1920 e quadrado 1080x1080 em JPEG', async () => {
  for (const [format, w, h] of [['story', 1080, 1920], ['square', 1080, 1080]] as const) {
    const out = await render(sample, format, frame(format));
    assert.deepEqual(sniff(out), { type: 'image/jpeg', width: w, height: h });
  }
  await assert.rejects(render(Buffer.from('lixo'), 'story', frame('story')), InvalidImage);
});

test('effectiveStatus expira por prazo, sem depender do TTL físico', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const base = { expiresAt: '2026-11-15T12:00:00Z', uploadExpiresAt: '2026-11-14T11:59:00Z' };
  assert.equal(effectiveStatus({ ...base, status: 'COMPLETED' }, now), 'COMPLETED');
  assert.equal(effectiveStatus({ ...base, status: 'COMPLETED', expiresAt: '2026-11-14T11:00:00Z' }, now), 'EXPIRED');
  assert.equal(effectiveStatus({ ...base, status: 'AWAITING_UPLOAD' }, now), 'AWAITING_UPLOAD');
  assert.equal(effectiveStatus({ ...base, status: 'AWAITING_UPLOAD', uploadExpiresAt: '2026-11-14T11:00:00Z' }, now), 'EXPIRED');
});
