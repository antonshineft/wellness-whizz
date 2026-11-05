/**
 * Instagram research carousels: a research note (src/research.ts) becomes a four-slide post. Claude writes the slide
 * copy in the minimal house style, the GitHub job carousel/build.mjs renders the slides from carousel/template.html,
 * the owner looks at them in the chat, and one call schedules them through Zernio for the next free morning slot.
 *
 * Statuses: copied (copy written, waiting for the render job) | rendering | ready (slides rendered, waiting for the
 * owner's go) | posted | failed.
 */
import { claudeJson } from './claude';
import { getSupplementBySlug } from './db';
import { getResearchNote, notePath, pubmedUrl, type ResearchNote } from './research';
import { nextSlot, type VideoEnv } from './videos';
import { createPost as zernioCreatePost, listAccounts as zernioAccounts, uploadMedia as zernioUploadMedia, type ZernioEnv } from './zernio';
import { alertRecipient, emailEnabled, sendEmail } from './email';

export type CarouselEnv = VideoEnv;

export interface CarouselRow {
  id: number;
  pmid: string;
  status: 'copied' | 'rendering' | 'ready' | 'posted' | 'failed';
  copy_json: string;
  caption: string;
  images_json: string;
  publish_id: string;
  error: string;
  created_at: string;
  updated_at: string;
  rendered_at: string | null;
}

export interface CarouselSlide {
  headline: string;
  quote: string;
  source: string;
  takeaway: string;
}

export interface CarouselCopy {
  cover: { headline: string; sub: string };
  found: CarouselSlide;
  catch: CarouselSlide;
  caption: string;
  hashtags: string[];
}

const SYSTEM = `You write four-slide Instagram carousels about one new study for Wellness Whizz, an AI supplement guide. The look is minimal: a flat cream background, one short headline per slide, one white card with a quote, one takeaway line. Every word is read on a phone, so everything is short.

Slides:
1. Cover: a headline of at most 4 words in Title Case ending with a full stop, stating the finding as plainly as possible ("Less Iron. Same Result."); a sub line of at most 14 words saying what kind of study it was and in whom.
2. What they found: a headline of at most 4 words; a quote of at most 28 words in plain language carrying the key number or comparison; a source line of at most 8 words saying what was measured or compared; a takeaway of at most 10 words.
3. The catch: a headline of at most 4 words ("The Catch." is fine); a quote of at most 28 words with the limits of the study (size, length, who, what it did not show); a source line of at most 8 words; a takeaway of at most 12 words that is cautious and practical ("Promising, not proven. Don't change a dose without advice.").
Then a caption for Instagram (at most 220 characters, the finding and the caveat in two sentences, no hashtags inside) and 5 lowercase hashtags without the # sign, the first being the supplement.

Rules: plain spoken English, numbers as digits, no exclamation marks, no emoji, no medical advice beyond "talk to a professional", never a claim that the supplement treats or cures anything, never invent a number that is not in the note. The quotes are paraphrases of the note, not of the paper, so no quotation marks inside them.`;

const copySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cover: { type: 'object', additionalProperties: false, properties: { headline: { type: 'string' }, sub: { type: 'string' } }, required: ['headline', 'sub'] },
    found: slideSchema(),
    catch: slideSchema(),
    caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 6 },
  },
  required: ['cover', 'found', 'catch', 'caption', 'hashtags'],
};

function slideSchema() {
  return { type: 'object', additionalProperties: false, properties: { headline: { type: 'string' }, quote: { type: 'string' }, source: { type: 'string' }, takeaway: { type: 'string' } }, required: ['headline', 'quote', 'source', 'takeaway'] };
}

export async function listCarousels(db: D1Database, limit = 30): Promise<CarouselRow[]> {
  return (await db.prepare('SELECT * FROM carousels ORDER BY id DESC LIMIT ?').bind(limit).all<CarouselRow>()).results;
}

export async function getCarousel(db: D1Database, pmid: string): Promise<CarouselRow | null> {
  return (await db.prepare('SELECT * FROM carousels WHERE pmid = ?').bind(pmid).first<CarouselRow>()) ?? null;
}

export function parseCopy(json: string): CarouselCopy | null {
  try {
    const c = JSON.parse(json) as CarouselCopy;
    return c && c.cover && c.found && c.catch ? c : null;
  } catch {
    return null;
  }
}

/** Write the slide copy for a research note and store the row as "copied" (the render job picks it up). */
export async function queueCarousel(env: CarouselEnv, pmid: string, force = false): Promise<{ ok: true; copy: CarouselCopy } | { ok: false; message: string }> {
  const note = await getResearchNote(env.DB, pmid);
  if (!note) return { ok: false, message: `no research note for PMID ${pmid}` };
  const existing = await getCarousel(env.DB, pmid);
  if (existing && !force && ['rendering', 'ready', 'posted'].includes(existing.status)) return { ok: false, message: `carousel for ${pmid} is already ${existing.status}` };
  const user = `Research note (already in plain language, written by the site):
Supplement: ${note.supplement_name}
Paper: ${note.title}
Journal: ${note.journal}, ${note.pub_date} (${note.pub_type})
Summary: ${note.summary}
What it means: ${note.takeaway}

Write the carousel.`;
  let copy: CarouselCopy;
  try {
    copy = await claudeJson<CarouselCopy>(env, SYSTEM, user, copySchema, { tier: 'fast', maxTokens: 2000, timeoutMs: 90_000 });
  } catch (err) {
    return { ok: false, message: `copy failed: ${String(err)}` };
  }
  const caption = `${copy.caption.trim()} ${copy.hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ')}`.trim();
  if (existing) {
    await env.DB.prepare("UPDATE carousels SET status = 'copied', copy_json = ?, caption = ?, images_json = '', error = '', updated_at = datetime('now') WHERE pmid = ?").bind(JSON.stringify(copy), caption, pmid).run();
  } else {
    await env.DB.prepare("INSERT INTO carousels (pmid, status, copy_json, caption, created_at, updated_at) VALUES (?, 'copied', ?, ?, datetime('now'), datetime('now'))").bind(pmid, JSON.stringify(copy), caption).run();
  }
  return { ok: true, copy };
}

/** Everything the render job needs for one carousel: the note, the supplement and its product photo, the copy. */
export async function carouselJob(env: CarouselEnv, pmid?: string): Promise<Record<string, unknown> | null> {
  const row = pmid
    ? await getCarousel(env.DB, pmid)
    : (await env.DB.prepare("SELECT * FROM carousels WHERE status = 'copied' ORDER BY id ASC LIMIT 1").first<CarouselRow>()) ?? null;
  if (!row || !['copied', 'rendering', 'failed', 'ready'].includes(row.status)) return null;
  const note = await getResearchNote(env.DB, row.pmid);
  const copy = parseCopy(row.copy_json);
  if (!note || !copy) return null;
  const origin = `https://${(env.CANONICAL_HOST ?? '').trim() || 'aiww.io'}`;
  const supplement = note.supplement_slug ? await getSupplementBySlug(env.DB, note.supplement_slug) : null;
  const product = supplement?.products.find((p) => p.image);
  const image = product?.image ? (product.image.startsWith('http') ? product.image : `${origin}${product.image}`) : supplement?.image ? (supplement.image.startsWith('http') ? supplement.image : `${origin}${supplement.image}`) : '';
  await env.DB.prepare("UPDATE carousels SET status = 'rendering', updated_at = datetime('now') WHERE id = ?").bind(row.id).run();
  return {
    pmid: row.pmid,
    note: { title: note.title, journal: note.journal, pub_date: note.pub_date, pub_type: note.pub_type, summary: note.summary, takeaway: note.takeaway, url: pubmedUrl(note.pmid), page: `${origin}${notePath(note)}` },
    supplement: { name: note.supplement_name, slug: note.supplement_slug, image, product: product?.name ?? '' },
    copy,
    caption: row.caption,
  };
}

export async function markCarouselReady(env: CarouselEnv, pmid: string, images: string[]): Promise<boolean> {
  const row = await getCarousel(env.DB, pmid);
  if (!row) return false;
  await env.DB.prepare("UPDATE carousels SET status = 'ready', images_json = ?, error = '', rendered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(JSON.stringify(images), row.id).run();
  await notify(env, `Carousel rendered, waiting for your go: ${pmid}`,
    `<p>The carousel for PMID <strong>${esc(pmid)}</strong> is rendered (${images.length} slides). Watch it in the chat with Claude and say yes there; nothing is posted until you do.</p>${images.map((u) => `<p><a href="${esc(u)}">${esc(u)}</a></p>`).join('')}`,
    `The carousel for PMID ${pmid} is rendered (${images.length} slides).\n${images.join('\n')}\n\nNothing is posted until you say so in the chat with Claude.`);
  return true;
}

export async function markCarouselFailed(env: CarouselEnv, pmid: string, error: string): Promise<boolean> {
  const row = await getCarousel(env.DB, pmid);
  if (!row) return false;
  await env.DB.prepare("UPDATE carousels SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?").bind(error.slice(0, 1000), row.id).run();
  return true;
}

export async function setCarouselStatus(env: CarouselEnv, pmid: string, status: CarouselRow['status']): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE carousels SET status = ?, updated_at = datetime('now') WHERE pmid = ?").bind(status, pmid).run();
  return (r.meta.changes ?? 0) > 0;
}

/** Schedule the rendered slides as an Instagram carousel through Zernio for the next free morning slot. */
export async function scheduleCarousel(env: CarouselEnv, pmid: string): Promise<{ ok: true; where: string; when: string } | { ok: false; message: string }> {
  const row = await getCarousel(env.DB, pmid);
  if (!row || row.status !== 'ready') return { ok: false, message: row ? `carousel is ${row.status}, not ready` : 'no such carousel' };
  let images: string[] = [];
  try { images = JSON.parse(row.images_json || '[]'); } catch { /* fall through */ }
  if (!images.length) return { ok: false, message: 'no rendered slides stored' };
  const z = env as ZernioEnv;
  const accounts = await zernioAccounts(z);
  if (!accounts.ok) return { ok: false, message: accounts.message };
  const targets = accounts.accounts.filter((a) => a.platform === 'instagram').map((a) => ({ platform: a.platform, accountId: a.id }));
  if (!targets.length) return { ok: false, message: 'no Instagram account is connected in Zernio' };
  const uploaded: string[] = [];
  for (const [i, url] of images.entries()) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return { ok: false, message: `fetching slide ${i + 1} failed: HTTP ${res.status}` };
    const up = await zernioUploadMedia(z, await res.arrayBuffer(), `carousel-${pmid}-${i + 1}-${Date.now()}.png`, 'image/png');
    if (!up.ok) return up;
    uploaded.push(up.url);
  }
  const slot = await nextSlot(env);
  const copy = parseCopy(row.copy_json);
  const post = await zernioCreatePost(z, { content: row.caption, mediaItems: uploaded.map((u) => ({ type: 'image', url: u })), targets, title: copy?.cover.headline ?? `Research ${pmid}`, scheduledFor: slot.local, timezone: slot.timezone });
  if (!post.ok) return post;
  await env.DB.prepare("UPDATE carousels SET status = 'posted', publish_id = ?, updated_at = datetime('now') WHERE id = ?").bind(`zernio:${post.id}`, row.id).run();
  return { ok: true, where: 'instagram', when: slot.label };
}

async function notify(env: CarouselEnv, subject: string, html: string, text: string): Promise<void> {
  if (!emailEnabled(env)) return;
  const to = (env.DIGEST_TO ?? '').trim() || alertRecipient(env);
  if (!to) return;
  try {
    await sendEmail(env, to, subject, `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.45;color:#1d272d;max-width:640px">${html}</div>`, text);
  } catch (err) {
    console.error(`carousel email failed: ${String(err)}`);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
}

export type { ResearchNote };
