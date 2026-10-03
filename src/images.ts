/**
 * Illustrations for supplements that have no product photos (the ones the quiz creates). A clean, brand-free bottle
 * or tub with the supplement name on the label is generated once with OpenAI's image model (transparent background,
 * in the style of the site's drawings), stored in D1 and served from /images/generated/<key>.webp.
 */
import type { Supplement } from './db';

export interface ImageEnv {
  DB: D1Database;
  OPENAI_API_KEY?: string;
  IMAGE_GENERATION?: string;
  IMAGE_MODEL?: string;
}

const DEFAULT_IMAGE_MODEL = 'gpt-image-1';

const CONTAINER: Record<string, string> = {
  capsule: 'a white matte supplement bottle of capsules',
  softgel: 'a white matte supplement bottle of softgels',
  small_softgel: 'a white matte supplement bottle of small softgels',
  tablet: 'a white matte supplement bottle of tablets',
  powder: 'a white matte powder tub with a screw lid',
  gummy: 'a white matte jar of gummies',
  bar: 'a wrapped nutrition bar in a plain matte wrapper',
  drops: 'a white matte dropper bottle',
};

/** Off unless IMAGE_GENERATION=true: the site prefers real product photos from iHerb (src/products.ts). */
export function imageGenerationEnabled(env: ImageEnv): boolean {
  return env.IMAGE_GENERATION === 'true' && !!env.OPENAI_API_KEY;
}

/** Generate and store the illustration; returns its public path. */
export async function generateSupplementImage(env: ImageEnv, sup: Supplement): Promise<string> {
  const container = CONTAINER[sup.form_type] ?? CONTAINER.capsule;
  const prompt =
    `Minimalist 3D product render of ${container}, with a soft light-green label that reads "${sup.name}" in a clean ` +
    'sans-serif font. No brand names, no logos, no other text. Centered, slight three-quarter angle, soft studio ' +
    'lighting, subtle shadow under the object only, transparent background. Friendly, modern wellness aesthetic.';

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'medium',
      background: 'transparent',
      output_format: 'webp',
      output_compression: 80,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Image API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { data?: { b64_json?: string }[] };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('Image API returned no image');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  const key = `supplement-${sup.slug}`;
  await storeImage(env.DB, key, 'image/webp', bytes);
  const path = `/images/generated/${key}.webp`;
  await env.DB.prepare('UPDATE supplements SET image = ? WHERE id = ?').bind(path, sup.id).run();
  return path;
}

export async function storeImage(db: D1Database, key: string, contentType: string, bytes: Uint8Array): Promise<void> {
  await db
    .prepare('INSERT INTO images (key, content_type, bytes) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET content_type = excluded.content_type, bytes = excluded.bytes')
    .bind(key, contentType, bytes)
    .run();
}

export async function loadImage(db: D1Database, key: string): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  const row = await db
    .prepare('SELECT content_type, bytes FROM images WHERE key = ?')
    .bind(key)
    .first<{ content_type: string; bytes: ArrayBuffer | Uint8Array | number[] }>();
  if (!row) return null;
  return { contentType: row.content_type, bytes: toBytes(row.bytes) };
}

/** D1 returns BLOBs as ArrayBuffer (or a plain number array in some runtimes). */
function toBytes(value: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value);
}

/** AI-created supplements that have neither product photos nor an illustration yet. */
export async function supplementsNeedingImage(db: D1Database, limit: number): Promise<{ id: number; slug: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, slug FROM supplements
       WHERE image = '' AND products_json NOT LIKE '%"image":%'
       ORDER BY source = 'ai' DESC, created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: number; slug: string }>();
  return results;
}
