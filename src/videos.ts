/**
 * Short videos for TikTok, one per published article.
 *
 * Queue: publishing an article queues a video (status "queued"). The 5-minute cron turns the next queued one into a
 * script with Claude (status "scripted"). A GitHub Actions job (video/render.py, .github/workflows/render-video.yml)
 * asks /api/admin/videos/next for the oldest scripted job, renders it (HeyGen clips for each posture, word-aligned
 * captions, product popup, music), publishes the mp4 as a release asset on the repository and reports back to
 * /api/admin/videos/<slug>/ready (status "ready"), which emails the owner a link to the posting page with the video
 * and caption pre-filled. Posting it from that page marks the row "posted".
 */
import { claudeJson } from './claude';
import { allPosts } from './blog/store';
import type { BlogPost } from './blog/types';
import { getSupplementBySlug } from './db';
import { alertRecipient, emailEnabled, sendEmail } from './email';

export interface VideoEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_MODEL_FAST?: string;
  CLAUDE_MODEL_SCREEN?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  DEV_FAKE_AI?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  ALERT_EMAIL?: string;
  DIGEST_TO?: string;
  CANONICAL_HOST?: string;
  STATS_KEY?: string;
  /** "false" stops new articles from queueing a video. */
  VIDEO_AUTOQUEUE?: string;
}

export type VideoStatus = 'queued' | 'scripted' | 'rendering' | 'ready' | 'posted' | 'failed';

export interface VideoRow {
  id: number;
  slug: string;
  status: VideoStatus;
  script_json: string;
  caption: string;
  video_url: string;
  duration: number;
  set_index: number;
  publish_id: string;
  error: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  rendered_at: string | null;
}

export type Pose = 'headshot' | 'half-body' | 'standing';

export interface VideoScript {
  title: string;
  segments: { pose: Pose; text: string }[];
  caption: string;
  hashtags: string[];
  product_slug: string;
  popup_after: string;
}

const RENDER_STALE_MINUTES = 150;
const MAX_ATTEMPTS = 2;

export function videosAutoQueue(env: VideoEnv): boolean {
  return env.VIDEO_AUTOQUEUE !== 'false';
}

function origin(env: VideoEnv): string {
  const host = (env.CANONICAL_HOST ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return host ? `https://${host}` : 'https://aiww.io';
}

export async function queueVideo(env: VideoEnv, slug: string): Promise<{ ok: boolean; message: string }> {
  const post = (await allPosts(env.DB)).find((p) => p.slug === slug);
  if (!post) return { ok: false, message: `No published article with slug "${slug}".` };
  const existing = await getVideo(env.DB, slug);
  if (existing && existing.status !== 'failed') return { ok: false, message: `A video for "${slug}" already exists (${existing.status}).` };
  if (existing) {
    await env.DB.prepare("UPDATE videos SET status = 'queued', error = '', attempts = 0, updated_at = datetime('now') WHERE slug = ?").bind(slug).run();
  } else {
    await env.DB.prepare('INSERT INTO videos (slug, status, created_at, updated_at) VALUES (?, ?, datetime(\'now\'), datetime(\'now\'))').bind(slug, 'queued').run();
  }
  return { ok: true, message: `Queued a video for "${slug}". The script is written within a few minutes; the render job picks it up on its next run.` };
}

export async function getVideo(db: D1Database, slug: string): Promise<VideoRow | null> {
  return (await db.prepare('SELECT * FROM videos WHERE slug = ?').bind(slug).first<VideoRow>()) ?? null;
}

export async function listVideos(db: D1Database, limit = 30): Promise<VideoRow[]> {
  return (await db.prepare('SELECT * FROM videos ORDER BY id DESC LIMIT ?').bind(limit).all<VideoRow>()).results;
}

export function parseScript(json: string): VideoScript | null {
  try {
    const s = JSON.parse(json) as VideoScript;
    return Array.isArray(s.segments) && s.segments.length ? s : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Script writing (Claude, fast tier)

const SCRIPT_SYSTEM = `You write 35 to 40 second spoken scripts for short vertical videos (TikTok, Reels) for Wellness Whizz, an AI supplement guide at aiww.io. One presenter speaks to camera; the video cuts between three postures, one per segment.

Rules:
- Three segments in this order: "headshot" (the hook and the single most useful number), "half-body" (the two or three details that matter), "standing" (the practical takeaway, then the closing line "Full guide at aiww.io.").
- 80 to 95 words in total across the three segments. Short spoken sentences. Write amounts with digits and units ("3 to 5 g a day", "20 minutes").
- Use only facts that are in the article. No claims the article does not make, no diagnosis, no "cures". Keep any caveat the article gives for a group of people (pregnancy, medication, kidney disease) if it is important.
- Plain confident tone, like a knowledgeable friend. No hype, no exclamation marks, no emoji, no em dashes, no bullet points, no hashtags in the spoken text.
- The caption is one plain sentence for TikTok (at most 140 characters) that states the key fact; hashtags are separate: 3 to 5 lowercase tags without the # sign, the first being the supplement.
- product_slug is the catalogue slug of the supplement the video is about (given in the task). popup_after is the exact first three words of the sentence during which the product photo should pop up (usually where the form or the product is mentioned, in the second or third segment).`;

const scriptSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Working title of the video, at most 60 characters.' },
    segments: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pose: { type: 'string', enum: ['headshot', 'half-body', 'standing'] },
          text: { type: 'string', description: 'What the presenter says in this segment: 2 to 5 short sentences.' },
        },
        required: ['pose', 'text'],
      },
    },
    caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5 },
    product_slug: { type: 'string' },
    popup_after: { type: 'string' },
  },
  required: ['title', 'segments', 'caption', 'hashtags', 'product_slug', 'popup_after'],
};

function plainText(html: string): string {
  return html
    .replace(/<\/(p|li|h2|h3|tr|blockquote)>/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export async function writeScript(env: VideoEnv, post: BlogPost): Promise<VideoScript> {
  const hero = post.heroSupplement || post.shop?.[0] || '';
  const sup = hero ? await getSupplementBySlug(env.DB, hero) : null;
  if (env.DEV_FAKE_AI === 'true') {
    return {
      title: post.title.slice(0, 60),
      segments: [
        { pose: 'headshot', text: `Quick one on ${sup?.name ?? post.title}. Here is the number that matters: 3 to 5 g a day, every day.` },
        { pose: 'half-body', text: 'Loading is optional. 20 g a day for a week gets you there faster, but you hold more water. Skip it and you get there in 3 to 4 weeks.' },
        { pose: 'standing', text: 'Buy plain monohydrate. The fancy forms cost more and do not do more. Full guide at aiww.io.' },
      ],
      caption: `${sup?.name ?? post.title}: the dose that works and how long it takes.`,
      hashtags: [(sup?.slug ?? 'supplements').replace(/-/g, ''), 'supplements', 'wellness'],
      product_slug: sup?.slug ?? hero,
      popup_after: 'Buy plain monohydrate',
    };
  }
  const body = plainText(post.html).slice(0, 14000);
  const faq = (post.faq ?? []).map((f) => `Q: ${f.q}\nA: ${plainText(f.a)}`).join('\n').slice(0, 3000);
  const user = `Article title: ${post.title}
Summary: ${post.description}
Supplement in the catalogue: ${sup ? `${sup.name} (slug ${sup.slug})` : `slug ${hero || 'unknown'}`}

Article text:
${body}

${faq ? `FAQ:\n${faq}` : ''}

Write the three-segment script, the caption, the hashtags, product_slug and popup_after.`;
  const script = await claudeJson<VideoScript>(env, SCRIPT_SYSTEM, user, scriptSchema, { tier: 'fast', maxTokens: 1500, timeoutMs: 60_000 });
  return tidyScript(script, sup?.slug ?? hero);
}

function tidyScript(s: VideoScript, fallbackSlug: string): VideoScript {
  const clean = (t: string) => t.replace(/\s*[—–]\s*/g, ', ').replace(/!/g, '.').replace(/\s+/g, ' ').trim();
  const poses: Pose[] = ['headshot', 'half-body', 'standing'];
  const segments = s.segments.slice(0, 3).map((seg, i) => ({ pose: poses[i], text: clean(seg.text) }));
  while (segments.length < 3) segments.push({ pose: poses[segments.length], text: 'Full guide at aiww.io.' });
  if (!/aiww\.io/i.test(segments[2].text)) segments[2].text = `${segments[2].text} Full guide at aiww.io.`;
  return {
    title: clean(s.title).slice(0, 60),
    segments,
    caption: clean(s.caption).slice(0, 140),
    hashtags: (s.hashtags ?? []).map((h) => h.replace(/[^a-z0-9]/gi, '').toLowerCase()).filter(Boolean).slice(0, 5),
    product_slug: (s.product_slug || fallbackSlug).trim(),
    popup_after: clean(s.popup_after),
  };
}

export function captionFor(script: VideoScript, slug: string): string {
  const tags = script.hashtags.map((h) => `#${h}`).join(' ');
  return `${script.caption} Full guide: aiww.io/blog/${slug} ${tags}`.trim();
}

/** Cron step: write the script for the oldest queued video. Returns true when it did something. */
export async function scriptNext(env: VideoEnv): Promise<boolean> {
  const row = await env.DB.prepare("SELECT * FROM videos WHERE status = 'queued' ORDER BY id LIMIT 1").first<VideoRow>();
  if (!row) return false;
  const post = (await allPosts(env.DB)).find((p) => p.slug === row.slug);
  if (!post) {
    await env.DB.prepare("UPDATE videos SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?").bind('article not found', row.id).run();
    return true;
  }
  try {
    const script = await writeScript(env, post);
    const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM videos WHERE status IN ('rendering', 'ready', 'posted')").first<{ n: number }>())?.n ?? 0;
    await env.DB.prepare("UPDATE videos SET status = 'scripted', script_json = ?, caption = ?, set_index = ?, error = '', updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(script), captionFor(script, row.slug), count, row.id).run();
  } catch (err) {
    const attempts = row.attempts + 1;
    const give_up = attempts >= MAX_ATTEMPTS;
    await env.DB.prepare("UPDATE videos SET status = ?, attempts = ?, error = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(give_up ? 'failed' : 'queued', attempts, String(err).slice(0, 500), row.id).run();
    if (give_up) await notify(env, `Video script failed: ${row.slug}`, `<p>Writing the script for <strong>${row.slug}</strong> failed twice:</p><pre>${escapeHtml(String(err).slice(0, 800))}</pre>`, `Writing the script for ${row.slug} failed twice:\n${String(err).slice(0, 800)}`);
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// The render job's side

export interface RenderJob {
  slug: string;
  title: string;
  script: VideoScript;
  caption: string;
  set_index: number;
  product_image: string | null;
  product_name: string | null;
  article_url: string;
}

/** Hand the oldest scripted video to the render job (and recover a render that never reported back). */
export async function nextJob(env: VideoEnv, onlySlug?: string): Promise<RenderJob | null> {
  await env.DB.prepare(`UPDATE videos SET status = 'scripted', error = 'render timed out; retrying', updated_at = datetime('now')
    WHERE status = 'rendering' AND updated_at < datetime('now', ?)`).bind(`-${RENDER_STALE_MINUTES} minutes`).run();
  const row = onlySlug
    ? await env.DB.prepare("SELECT * FROM videos WHERE slug = ? AND status IN ('scripted', 'ready', 'failed')").bind(onlySlug).first<VideoRow>()
    : await env.DB.prepare("SELECT * FROM videos WHERE status = 'scripted' ORDER BY id LIMIT 1").first<VideoRow>();
  if (!row) return null;
  const script = parseScript(row.script_json);
  if (!script) {
    await env.DB.prepare("UPDATE videos SET status = 'failed', error = 'script is not valid JSON', updated_at = datetime('now') WHERE id = ?").bind(row.id).run();
    return null;
  }
  const sup = script.product_slug ? await getSupplementBySlug(env.DB, script.product_slug) : null;
  const image = sup?.products?.find((p) => p.image)?.image ?? sup?.image ?? null;
  await env.DB.prepare("UPDATE videos SET status = 'rendering', error = '', updated_at = datetime('now') WHERE id = ?").bind(row.id).run();
  return {
    slug: row.slug,
    title: script.title,
    script,
    caption: row.caption,
    set_index: row.set_index,
    product_image: image ? (image.startsWith('http') ? image : `${origin(env)}${image}`) : null,
    product_name: sup?.name ?? null,
    article_url: `${origin(env)}/blog/${row.slug}`,
  };
}

export async function markReady(env: VideoEnv, slug: string, videoUrl: string, duration: number): Promise<boolean> {
  const row = await getVideo(env.DB, slug);
  if (!row) return false;
  await env.DB.prepare("UPDATE videos SET status = 'ready', video_url = ?, duration = ?, error = '', rendered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .bind(videoUrl, duration, row.id).run();
  const page = `${origin(env)}/api/admin/tiktok?key=${encodeURIComponent(env.STATS_KEY ?? '')}&video=${encodeURIComponent(slug)}`;
  const script = parseScript(row.script_json);
  await notify(env, `Video ready to post: ${script?.title ?? slug}`,
    `<p>The video for <strong>${escapeHtml(slug)}</strong> is rendered (${Math.round(duration)} s).</p>
<p><a href="${escapeHtml(videoUrl)}">Watch it</a> · <a href="${escapeHtml(page)}" style="display:inline-block;background:#1d272d;color:#fff;text-decoration:none;border-radius:10px;padding:12px 18px;font-size:16px">Post to TikTok</a></p>
<p style="color:#555">Caption: ${escapeHtml(row.caption)}</p>
<p style="color:#777;font-size:13px">Nothing is posted until you press Post on that page.</p>`,
    `The video for ${slug} is rendered (${Math.round(duration)} s).\n\nWatch: ${videoUrl}\nPost to TikTok: ${page}\n\nCaption: ${row.caption}\n\nNothing is posted until you press Post on that page.`);
  return true;
}

export async function markFailed(env: VideoEnv, slug: string, error: string): Promise<boolean> {
  const row = await getVideo(env.DB, slug);
  if (!row) return false;
  const attempts = row.attempts + 1;
  const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'scripted';
  await env.DB.prepare("UPDATE videos SET status = ?, attempts = ?, error = ?, updated_at = datetime('now') WHERE id = ?").bind(status, attempts, error.slice(0, 1000), row.id).run();
  if (status === 'failed') await notify(env, `Video render failed: ${slug}`, `<p>Rendering <strong>${escapeHtml(slug)}</strong> failed twice:</p><pre>${escapeHtml(error.slice(0, 1200))}</pre>`, `Rendering ${slug} failed twice:\n${error.slice(0, 1200)}`);
  return true;
}

export async function markPosted(env: VideoEnv, slug: string, publishId: string): Promise<void> {
  await env.DB.prepare("UPDATE videos SET status = 'posted', publish_id = ?, updated_at = datetime('now') WHERE slug = ?").bind(publishId, slug).run();
}

async function notify(env: VideoEnv, subject: string, html: string, text: string): Promise<void> {
  if (!emailEnabled(env)) return;
  const to = (env.DIGEST_TO ?? '').trim() || alertRecipient(env);
  if (!to) return;
  try {
    await sendEmail(env, to, subject, `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.45;color:#1d272d;max-width:640px">${html}</div>`, text);
  } catch (err) {
    console.error(`video email failed: ${String(err)}`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
}
