/**
 * Short explainer videos for TikTok, one per published article.
 *
 * Queue: publishing an article queues a video (status "queued"). The 5-minute cron turns the next queued one into a
 * six-scene script with Claude (status "scripted"): one surprising fact per scene, spoken by a narrator, plus a
 * description of the hand-drawn animated scene that goes with it. A GitHub Actions job (video/render.py,
 * .github/workflows/render-video.yml) asks /api/admin/videos/next for the oldest scripted job, renders it (one clip per
 * scene with Google's Gemini Omni Flash in the site's illustration style, ElevenLabs narration, burned-in captions,
 * a music bed), publishes the mp4 as a release asset on the repository and reports back to
 * /api/admin/videos/<slug>/ready (status "ready"), which posts it through Zernio (status "posted") or, with
 * VIDEO_AUTOPOST=false, emails the owner a link to the posting page with the video and caption pre-filled.
 */
import { claudeJson } from './claude';
import { allPosts } from './blog/store';
import type { BlogPost } from './blog/types';
import { getSupplementBySlug } from './db';
import { alertRecipient, emailEnabled, sendEmail } from './email';
import { createPost as zernioCreatePost, listAccounts as zernioAccounts, uploadMedia as zernioUploadMedia, uploadVideo as zernioUpload, zernioEnabled, type ZernioEnv } from './zernio';

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
  /** "false" keeps rendered videos on the posting page instead of posting them through Zernio at once. */
  VIDEO_AUTOPOST?: string;
  ZERNIO_API_KEY?: string;
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

export interface VideoScene {
  /** What the narrator says over this scene: at most MAX_SCENE_WORDS words, about nine seconds. */
  narration: string;
  /** What the viewer sees: the animated scene described for the video model, no text or numbers on screen. */
  visual: string;
}

export interface VideoScript {
  title: string;
  /** SCENES scenes of ten seconds: the hook, four facts, a calm ending. */
  scenes: VideoScene[];
  caption: string;
  hashtags: string[];
  product_slug: string;
}

const RENDER_STALE_MINUTES = 150;
/** Scenes per video; each is a ten-second clip. */
export const SCENES = 6;
const MIN_SCENES = 4;
/** Spoken words per scene; the narrator (ElevenLabs "Daniel") fits about 22 words into nine seconds at his natural pace. */
export const MAX_SCENE_WORDS = 24;
/** Spoken words per video. The render job refuses scripts far above this. */
const MAX_SCRIPT_WORDS = SCENES * MAX_SCENE_WORDS;
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

/** One line for the daily digest: videos posted or failed in the last 24 hours ('' when nothing happened). */
export async function videoDigestLine(db: D1Database): Promise<string> {
  const rows = (await db.prepare("SELECT slug, status, error FROM videos WHERE updated_at >= datetime('now', '-1 day') AND status IN ('posted', 'failed') ORDER BY updated_at DESC LIMIT 10").all<Pick<VideoRow, 'slug' | 'status' | 'error'>>()).results ?? [];
  if (!rows.length) return '';
  const posted = rows.filter((r) => r.status === 'posted').map((r) => r.slug);
  const failed = rows.filter((r) => r.status === 'failed').map((r) => `${r.slug} (${(r.error || 'unknown error').replace(/^\w+Error: /, '').slice(0, 120)})`);
  return [posted.length ? `Videos posted: ${posted.join(', ')}.` : '', failed.length ? `Video FAILED, needs a re-queue: ${failed.join('; ')}.` : ''].filter(Boolean).join(' ');
}

export async function listVideos(db: D1Database, limit = 30): Promise<VideoRow[]> {
  return (await db.prepare('SELECT * FROM videos ORDER BY id DESC LIMIT ?').bind(limit).all<VideoRow>()).results;
}

/** The stored script, or null when it is missing, malformed or in the retired presenter format (segments with poses). */
export function parseScript(json: string): VideoScript | null {
  try {
    const s = JSON.parse(json) as VideoScript;
    return Array.isArray(s.scenes) && s.scenes.length >= MIN_SCENES && s.scenes.every((sc) => typeof sc?.narration === 'string' && typeof sc?.visual === 'string') ? s : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Script writing (Claude, fast tier)

const SCRIPT_SYSTEM = `You write sixty-second explainer videos for TikTok for Wellness Whizz, an AI supplement guide. The video is a hand-drawn animated infographic (a soft-teal cartoon figure, pastel objects, cream paper background) with one narrator. It is built from ${SCENES} scenes of ten seconds; for each scene you write what the narrator says and what the viewer sees.

What makes these videos work: every scene is ONE genuinely surprising fact for a curious mind. Origin stories, odd history, strange chemistry, a number that sounds impossible, a myth busted, a counter-intuitive detail about how the body handles the substance. Never the obvious ("vitamin C supports immunity"), never a list of benefits, never "studies show it may help". The first scene is the strongest hook of all: a fact that makes someone stop scrolling. The last scene lands calmly on the one practical takeaway (which form, with what, when), so the video feels finished. No call to action, no "follow", no "link in bio", no website mention anywhere in the narration.

Narration rules:
- At most ${MAX_SCENE_WORDS} words per scene, usually 16 to 21. Short spoken sentences with a verb. The narrator is a calm, warm British man; write for his voice.
- Write numbers and years as words, the way they are spoken: "nineteen ninety-two", "about a quarter", "thirty-eight trillion", "ten milligrams". Never digits, never the percent sign.
- Facts come from the article first. You may add well-known, well-documented general knowledge about the supplement (its discovery, origin, chemistry, famous studies) that a good reference book would confirm. Never invent a number, a study or a name. Keep any safety caveat the article gives for a group of people if it matters (pregnancy, medication, kidney disease, thyroid).
- Plain, confident, a little playful. No hype, no exclamation marks, no emoji, no em dashes, no bullet points, no hashtags in the narration, no "did you know".

Visual rules (the "visual" field is handed to a video generation model, so describe it like a shot list):
- Three beats with timing, "0 to 4 s: ... 4 to 7 s: ... 7 to 10 s: ...", each a concrete thing happening: objects, a simple soft-teal cartoon figure, hands, a kitchen, a lab bench, a stadium, a village. Always in motion: things pour, grow, shrink, fill, drift, light up; the camera pushes in or drifts.
- Name colours from this palette: soft teal, sage green, pale cerulean, terracotta, straw yellow, cream. One idea per beat, clean and uncluttered, plenty of breathing room.
- No text, no numbers, no letters, no labels, no logos, no clocks with numerals, no calendars with digits anywhere in the scene; say so in the description when a label would be natural (a blank label, a notebook with only scribble lines).
- Nothing a safety filter could misread: no powders being snorted or injected, no needles, no blood, no gore, no nudity, no real people, no children, no brand names. A "scoop of white powder" reads badly to filters; say "small soft white spheres" or "a spoon of pale crystals" instead.
- Scene ${SCENES} is the calm ending: a restful composition (a figure sipping a drink by a window, a sunrise over rooftops, a quiet breakfast table) that settles rather than stops.

The caption is one hook sentence for TikTok (at most 140 characters) stating the most surprising fact; hashtags are separate: 4 or 5 lowercase tags without the # sign, the first being the supplement. product_slug is the catalogue slug of the supplement the video is about (given in the task).`;

const scriptSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Working title of the video, at most 60 characters: the hook in a few words.' },
    scenes: {
      type: 'array',
      description: `Exactly ${SCENES} scenes: the hook, four more facts, the calm ending.`,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          narration: { type: 'string', description: `What the narrator says during this scene: at most ${MAX_SCENE_WORDS} words, numbers written as words.` },
          visual: { type: 'string', description: 'The animated scene for the video model: three timed beats, concrete objects and motion, palette colours, no text or numbers anywhere.' },
        },
        required: ['narration', 'visual'],
      },
    },
    caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' }, description: '4 or 5 lowercase tags without the # sign.' },
    product_slug: { type: 'string' },
  },
  required: ['title', 'scenes', 'caption', 'hashtags', 'product_slug'],
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
    const figure = 'a simple soft-teal cartoon figure';
    return {
      title: `The sprinters' secret: ${sup?.name ?? post.title}`.slice(0, 60),
      scenes: [
        { narration: "Barcelona, nineteen ninety-two. Britain's gold-medal sprinters had quietly been using a legal white powder nobody in sport had heard of.", visual: `0 to 4 s: a hand-drawn stadium at dusk, ${figure} explodes from the starting blocks on a terracotta track. 4 to 7 s: the sprinter crosses the line and a plain gold medal swings. 7 to 10 s: a sage-green gym bag on a bench, inside it a plain white tub with a blank label glowing softly.` },
        { narration: "Creatine. Within a year it was in every gym bag. Today it's the most tested supplement in sport, hundreds of trials deep.", visual: `0 to 4 s: gym bags pop open one after another, each with the same white tub. 4 to 7 s: the tubs become a mountain of blank paper sheets with scribble lines. 7 to 10 s: ${figure} in a straw-yellow coat stands on top and gives a thumbs-up.` },
        { narration: "It's a battery. Your muscles drain their instant energy in about ten seconds. Creatine recharges it: one more rep, one more sprint.", visual: `0 to 4 s: ${figure} lifts a barbell while a rounded battery beside it drains its straw-yellow bar. 4 to 7 s: small soft white spheres flow in and the bar fills with a glow. 7 to 10 s: one more strong lift, then a sprint on a terracotta track.` },
        { narration: 'Your brain uses the same battery. In trials, sleep-deprived people and low-store vegetarians scored better on memory tests after taking it.', visual: `0 to 4 s: a side profile of ${figure} with a glowing brain and a small battery inside it. 4 to 7 s: two vignettes, a yawning figure under a crescent moon and a figure eating leafy greens. 7 to 10 s: white spheres fill both batteries and puzzle pieces click together above their heads.` },
        { narration: "The kidney scare is a reading error. Creatine raises creatinine on blood tests, the number doctors watch, but it's just a harmless by-product.", visual: `0 to 4 s: ${figure} sits worried across a desk from a doctor in a straw-yellow coat; sage-green kidneys float above, glowing healthy. 4 to 7 s: inside a test tube, white spheres break into harmless flecks. 7 to 10 s: the doctor smiles and the figure relaxes.` },
        { narration: 'Skip the fancy versions. Plain monohydrate is the one from the trials. Three to five grams a day, whenever. Nothing newer beats it.', visual: `0 to 4 s: a shelf of loud colourful tubs shrinks away, leaving one plain white tub. 4 to 7 s: a teaspoon drops small soft white spheres into a glass of water on a wooden table. 7 to 10 s: ${figure} sips by a window at sunrise and leans back, the camera slowly pulling out.` },
      ],
      caption: "In 1992 Britain's Olympic sprinters were quietly using a legal white powder nobody had heard of. Creatine.",
      hashtags: [(sup?.slug ?? 'supplements').replace(/-/g, ''), 'supplements', 'gym', 'fitness', 'wellness'],
      product_slug: sup?.slug ?? hero,
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

Write the ${SCENES}-scene script (narration and visual for each), the caption, the hashtags and product_slug.`;
  let script = tidyScript(await claudeJson<VideoScript>(env, SCRIPT_SYSTEM, user, scriptSchema, { tier: 'fast', maxTokens: 6000, timeoutMs: 90_000 }), sup?.slug ?? hero);
  // The model tends to overshoot; one shortening pass keeps every scene inside its ten seconds.
  const long = script.scenes.map((s, i) => ({ i, n: words(s.narration) })).filter((x) => x.n > MAX_SCENE_WORDS);
  if (long.length || wordCount(script) > MAX_SCRIPT_WORDS) {
    const shorter = await claudeJson<VideoScript>(env, SCRIPT_SYSTEM,
      `${user}\n\nYour previous script is too long for the narrator: ${long.map((x) => `scene ${x.i + 1} has ${x.n} words`).join(', ') || `${wordCount(script)} words in total`}. Here it is:\n${JSON.stringify(script)}\n\nRewrite it with at most ${MAX_SCENE_WORDS - 2} words in every scene's narration, same scenes and facts, same visuals; cut the least important clause of each long scene.`,
      scriptSchema, { tier: 'fast', maxTokens: 6000, timeoutMs: 90_000 });
    const tidied = tidyScript(shorter, sup?.slug ?? hero);
    if (Math.max(...tidied.scenes.map((s) => words(s.narration))) <= Math.max(...script.scenes.map((s) => words(s.narration)))) script = tidied;
  }
  const worst = Math.max(...script.scenes.map((s) => words(s.narration)));
  if (worst > MAX_SCENE_WORDS + 6) throw new Error(`a scene still has ${worst} words after shortening`);
  return script;
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function wordCount(s: VideoScript): number {
  return s.scenes.reduce((n, sc) => n + words(sc.narration), 0);
}

function tidyScript(s: VideoScript, fallbackSlug: string): VideoScript {
  const clean = (t: string) => (t ?? '').replace(/\s*[—–]\s*/g, ', ').replace(/!/g, '.').replace(/\s+/g, ' ').trim();
  // No website call to action in the spoken text: drop any sentence that names the site.
  const noCta = (t: string) => t.split(/(?<=[.?])\s+/).filter((sentence) => !/aiww\.io|link in bio|follow (us|me)/i.test(sentence)).join(' ').trim();
  const scenes = (s.scenes ?? []).slice(0, SCENES).map((sc) => ({ narration: noCta(clean(sc.narration)), visual: clean(sc.visual) })).filter((sc) => sc.narration && sc.visual);
  if (scenes.length < MIN_SCENES) throw new Error(`the script has ${scenes.length} usable scenes; ${SCENES} expected`);
  return {
    title: clean(s.title).slice(0, 60),
    scenes,
    caption: clean(s.caption).slice(0, 140),
    hashtags: (s.hashtags ?? []).map((h) => h.replace(/[^a-z0-9]/gi, '').toLowerCase()).filter(Boolean).slice(0, 5),
    product_slug: (s.product_slug || fallbackSlug).trim(),
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
    // Malformed, or written for the retired presenter format: back to the queue, the next cron rewrites it.
    await env.DB.prepare("UPDATE videos SET status = 'queued', script_json = '', error = 'script rewritten for the explainer format', updated_at = datetime('now') WHERE id = ?").bind(row.id).run();
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

export async function markReady(env: VideoEnv, slug: string, videoUrl: string, duration: number, coverUrl = ''): Promise<boolean> {
  const row = await getVideo(env.DB, slug);
  if (!row) return false;
  await env.DB.prepare("UPDATE videos SET status = 'ready', video_url = ?, duration = ?, error = '', rendered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .bind(videoUrl, duration, row.id).run();
  const page = `${origin(env)}/api/admin/tiktok?key=${encodeURIComponent(env.STATS_KEY ?? '')}&video=${encodeURIComponent(slug)}`;
  const script = parseScript(row.script_json);
  if (env.VIDEO_AUTOPOST !== 'false' && zernioEnabled(env as ZernioEnv)) {
    const posted = await autoPost(env, { ...row, video_url: videoUrl }, coverUrl);
    if (posted.ok) {
      await notify(env, `Posted on ${posted.where}: ${script?.title ?? slug}`,
        `<p>The video for <strong>${escapeHtml(slug)}</strong> (${Math.round(duration)} s) was posted through Zernio to ${escapeHtml(posted.where)}. It is live within a few minutes.</p>
<p style="color:#555">Caption: ${escapeHtml(row.caption)}</p><p><a href="${escapeHtml(videoUrl)}">Watch the file</a> · <a href="${escapeHtml(page)}">Posting page</a></p>`,
        `The video for ${slug} (${Math.round(duration)} s) was posted through Zernio to ${posted.where}.\n\nCaption: ${row.caption}\n\nFile: ${videoUrl}\nPosting page: ${page}`);
      return true;
    }
    await notify(env, `Video rendered, posting failed: ${script?.title ?? slug}`,
      `<p>The video for <strong>${escapeHtml(slug)}</strong> is rendered but the automatic post failed: ${escapeHtml(posted.message)}</p><p><a href="${escapeHtml(page)}" style="display:inline-block;background:#1d272d;color:#fff;text-decoration:none;border-radius:10px;padding:12px 18px;font-size:16px">Post it by hand</a></p>`,
      `The video for ${slug} is rendered but the automatic post failed: ${posted.message}\n\nPost it by hand: ${page}`);
    return true;
  }
  await notify(env, `Video ready to post: ${script?.title ?? slug}`,
    `<p>The video for <strong>${escapeHtml(slug)}</strong> is rendered (${Math.round(duration)} s).</p>
<p><a href="${escapeHtml(videoUrl)}">Watch it</a> · <a href="${escapeHtml(page)}" style="display:inline-block;background:#1d272d;color:#fff;text-decoration:none;border-radius:10px;padding:12px 18px;font-size:16px">Post to TikTok</a></p>
<p style="color:#555">Caption: ${escapeHtml(row.caption)}</p>
<p style="color:#777;font-size:13px">Nothing is posted until you press Post on that page.</p>`,
    `The video for ${slug} is rendered (${Math.round(duration)} s).\n\nWatch: ${videoUrl}\nPost to TikTok: ${page}\n\nCaption: ${row.caption}\n\nNothing is posted until you press Post on that page.`);
  return true;
}

/** Post a rendered video through every connected Zernio account (public, labelled as AI content); the cover, when
 *  there is one, becomes the Instagram Reel cover so the profile grid shows the title rather than a random frame. */
export async function autoPost(env: VideoEnv, row: VideoRow, coverUrl = ''): Promise<{ ok: true; where: string } | { ok: false; message: string }> {
  const z = env as ZernioEnv;
  const accounts = await zernioAccounts(z);
  if (!accounts.ok) return { ok: false, message: accounts.message };
  const targets = accounts.accounts.filter((a) => ['tiktok', 'instagram', 'youtube'].includes(a.platform)).map((a) => ({ platform: a.platform, accountId: a.id }));
  if (!targets.length) return { ok: false, message: 'no TikTok, Instagram or YouTube account is connected in Zernio' };
  const res = await fetch(row.video_url, { redirect: 'follow' });
  if (!res.ok) return { ok: false, message: `fetching the rendered file failed: HTTP ${res.status}` };
  const up = await zernioUpload(z, await res.arrayBuffer(), `${row.slug}-${Date.now()}.mp4`);
  if (!up.ok) return up;
  let cover = '';
  if (coverUrl && targets.some((t) => t.platform === 'instagram')) {
    try {
      const cr = await fetch(coverUrl, { redirect: 'follow' });
      const cu = cr.ok ? await zernioUploadMedia(z, await cr.arrayBuffer(), `${row.slug}-${Date.now()}-cover.jpg`, 'image/jpeg') : null;
      if (cu?.ok) cover = cu.url;
      else console.warn(`video cover not attached for ${row.slug}: ${cu ? cu.message : `HTTP ${cr.status}`}`);
    } catch (err) {
      console.warn(`video cover not attached for ${row.slug}: ${String(err)}`);
    }
  }
  const post = await zernioCreatePost(z, { content: row.caption, mediaUrl: up.url, targets, privacy: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false, madeWithAi: true, title: parseScript(row.script_json)?.title ?? row.slug, coverUrl: cover });
  if (!post.ok) return post;
  await markPosted(env, row.slug, `zernio:${post.id}`);
  return { ok: true, where: targets.map((t) => t.platform).join(', ') };
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
