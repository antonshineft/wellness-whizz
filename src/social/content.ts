/**
 * What the site posts to X, and when. Three kinds, all about the site's own content:
 *   article  - a 3 to 4 post thread for each blog article (once per article)
 *   fact     - one post a day with a fact from a supplement page, rotating through the catalogue
 *   research - a post per new research note (at most a couple a week)
 * Posts wait in social_posts and go out from the hourly cron inside a daytime window, a few per day at most.
 * Each kind has its own lane: a backlog of article threads never stops facts or research notes from being drafted,
 * and the sender rotates between kinds so a research note goes out even while a dozen threads are queued.
 */
import { POSTS, type BlogPost } from '../blog';
import { getMeta, listSupplements, setMeta, type Supplement } from '../db';
import { chatJson, useFakeAi, type AiEnv } from '../openai';
import { pubmedUrl, unqueuedNotes } from '../research';
import { postThread, tweetLength, xEnabled, type XEnv } from './x';

export interface SocialEnv extends AiEnv, XEnv {
  DB: D1Database;
  CANONICAL_HOST?: string;
  X_AUTOPOST?: string;
  X_POSTS_PER_DAY?: string;
}

export interface SocialPost {
  id: number;
  channel: string;
  kind: string;
  ref: string;
  thread_json: string;
  status: string;
  scheduled_at: string;
  posted_at: string | null;
  external_id: string | null;
  error: string | null;
  created_at: string;
}

const MAX_TWEET = 270; // leave headroom under 280 after URL counting
const WINDOW_START_UTC = 7;
const WINDOW_END_UTC = 20;
const MIN_GAP_MINUTES = 150;

export function siteOrigin(env: SocialEnv): string {
  const host = (env.CANONICAL_HOST ?? '').trim();
  return host ? `https://${host.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}` : 'https://aiww.io';
}

function clampTweet(text: string, max = MAX_TWEET): string {
  let t = text.replace(/\s+/g, ' ').trim();
  while (tweetLength(t) > max) t = t.slice(0, t.length - 10).replace(/\s+\S*$/, '').trim() + '…';
  return t;
}

async function enqueue(db: D1Database, kind: string, ref: string, tweets: string[], when: Date): Promise<void> {
  await db
    .prepare('INSERT INTO social_posts (channel, kind, ref, thread_json, scheduled_at) VALUES (?, ?, ?, ?, ?)')
    .bind('x', kind, ref, JSON.stringify(tweets.map((t) => clampTweet(t))), when.toISOString().slice(0, 19).replace('T', ' '))
    .run();
}

// ---------- drafts ----------

const threadSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tweets: { type: 'array', items: { type: 'string' }, description: '3 or 4 posts, each under 240 characters. No hashtags, no emoji, no URLs.' },
  },
  required: ['tweets'],
} as const;

const factSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string', description: 'One post under 200 characters. No hashtags, no emoji, no URL.' } },
  required: ['text'],
} as const;

const VOICE =
  'Voice: calm, specific, evidence-first, like a well-read friend who happens to be a pharmacist. Short sentences. ' +
  'No hype, no exclamation marks, no "game changer", no emoji, no hashtags. Never promise cures. Numbers and forms over adjectives.';

async function articleThread(env: SocialEnv, post: BlogPost): Promise<string[]> {
  const url = `${siteOrigin(env)}/blog/${post.slug}`;
  if (useFakeAi(env)) return [`[Dev mode] ${post.title}`, `[Dev mode] ${post.excerpt}`, `Full article: ${url}`];
  const text = post.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2500);
  const draft = await chatJson<{ tweets: string[] }>(
    env,
    'article_thread',
    threadSchema,
    [
      `Write a thread for X announcing this article from Wellness Whizz. ${VOICE}`,
      'Post 1 is the hook: the single most useful, concrete point of the article, stated plainly. Posts 2 and 3 each give one specific finding or rule of thumb. Do not include the link; it is added separately.',
      `Title: ${post.title}`,
      `Description: ${post.description}`,
      `Article text (beginning): ${text}`,
    ].join('\n'),
  );
  const tweets = (draft.tweets ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 4);
  if (!tweets.length) throw new Error('empty thread draft');
  tweets.push(`Full article, with sources and the products we checked: ${url}`);
  return tweets;
}

async function factPost(env: SocialEnv, sup: Supplement): Promise<string[]> {
  const url = `${siteOrigin(env)}/supplement/${sup.slug}`;
  if (useFakeAi(env)) return [`[Dev mode] ${sup.name}: ${sup.summary} ${url}`];
  const article = sup.holistic_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1800);
  const draft = await chatJson<{ text: string }>(
    env,
    'fact_post',
    factSchema,
    [
      `Write one post for X about ${sup.name} for Wellness Whizz. ${VOICE}`,
      'Pick one concrete, useful detail (a dose range, a timing rule, a form that absorbs better, a common mistake, who should not take it) and state it as a tip. End with a short clause that invites reading the full profile, without a link.',
      `Summary: ${sup.summary}`,
      `Benefits: ${sup.benefits_html.replace(/<[^>]+>/g, ' ').slice(0, 600)}`,
      `Article: ${article}`,
    ].join('\n'),
  );
  const text = (draft.text ?? '').trim();
  if (!text) throw new Error('empty fact draft');
  return [`${text} ${url}`];
}

// ---------- queue builders (idempotent, run hourly) ----------

export async function buildQueue(env: SocialEnv): Promise<{ queued: string[] }> {
  const queued: string[] = [];
  const now = new Date();
  const pendingByKind = new Map<string, number>();
  for (const row of (await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM social_posts WHERE status = 'queued' GROUP BY kind").all<{ kind: string; n: number }>()).results) {
    pendingByKind.set(row.kind, Number(row.n));
  }
  const pending = (kind: string) => pendingByKind.get(kind) ?? 0;

  // 1. One thread per article, never twice (meta flag); drafted one per run while fewer than three threads wait.
  for (const post of POSTS) {
    if (pending('article') >= 3) break;
    const flag = `x:article:${post.slug}`;
    if (await getMeta(env.DB, flag)) continue;
    const tweets = await articleThread(env, post);
    await enqueue(env.DB, 'article', post.slug, tweets, now);
    await setMeta(env.DB, flag, now.toISOString());
    queued.push(`article:${post.slug}`);
    break; // one per run; the next hour handles the next article
  }

  // 2. One supplement fact per day.
  const today = now.toISOString().slice(0, 10);
  const factToday = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM social_posts WHERE kind = 'fact' AND substr(created_at, 1, 10) = ?")
    .bind(today)
    .first<{ n: number }>();
  if (!(factToday?.n ?? 0) && pending('fact') < 2) {
    const all = (await listSupplements(env.DB, 500, true)).filter((s) => s.holistic_html.length > 400);
    const done = new Set((await env.DB.prepare("SELECT ref FROM social_posts WHERE kind = 'fact'").all<{ ref: string }>()).results.map((r) => r.ref));
    const candidates = all.filter((s) => !done.has(s.slug));
    const pool = candidates.length ? candidates : all;
    if (pool.length) {
      const sup = pool[Math.floor(Math.random() * pool.length)];
      const tweets = await factPost(env, sup);
      await enqueue(env.DB, 'fact', sup.slug, tweets, now);
      queued.push(`fact:${sup.slug}`);
    }
  }

  // 3. Research notes: at most two queued per 7 days, drafted regardless of the article backlog.
  const recentResearch = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM social_posts WHERE kind = 'research' AND created_at >= datetime('now', '-7 days')")
    .first<{ n: number }>();
  if ((recentResearch?.n ?? 0) < 2) {
    for (const note of await unqueuedNotes(env.DB, 1)) {
      const page = `${siteOrigin(env)}/supplement/${note.supplement_slug}`;
      const text = `${note.tweet.trim()} Study: ${pubmedUrl(note.pmid)} Our ${note.supplement_name} profile: ${page}`;
      await enqueue(env.DB, 'research', note.pmid, [text], now);
      await env.DB.prepare('UPDATE research_notes SET queued = 1 WHERE id = ?').bind(note.id).run();
      queued.push(`research:${note.pmid}`);
    }
  }
  return { queued };
}

// ---------- posting ----------

export async function postDue(env: SocialEnv): Promise<{ posted: string[]; failed: string[]; skipped: string }> {
  const posted: string[] = [];
  const failed: string[] = [];
  if (env.X_AUTOPOST === 'false') return { posted, failed, skipped: 'X_AUTOPOST=false' };
  if (!xEnabled(env)) return { posted, failed, skipped: 'X keys not configured' };
  const now = new Date();
  const hour = now.getUTCHours();
  if (hour < WINDOW_START_UTC || hour >= WINDOW_END_UTC) return { posted, failed, skipped: 'outside posting window' };

  const perDay = Math.max(1, Number(env.X_POSTS_PER_DAY ?? '2') || 2);
  const todayCount = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM social_posts WHERE status = 'posted' AND posted_at >= datetime('now', '-24 hours')")
    .first<{ n: number }>();
  if ((todayCount?.n ?? 0) >= perDay) return { posted, failed, skipped: 'daily cap reached' };
  const last = await env.DB.prepare("SELECT MAX(posted_at) AS t FROM social_posts WHERE status = 'posted'").first<{ t: string | null }>();
  if (last?.t && now.getTime() - Date.parse(last.t + 'Z') < MIN_GAP_MINUTES * 60_000) return { posted, failed, skipped: 'too soon after the last post' };

  const next = await nextDue(env.DB);
  if (!next) return { posted, failed, skipped: 'nothing due' };
  try {
    const tweets = JSON.parse(next.thread_json) as string[];
    const id = await postThread(env, tweets);
    await env.DB.prepare("UPDATE social_posts SET status = 'posted', posted_at = datetime('now'), external_id = ? WHERE id = ?").bind(id, next.id).run();
    posted.push(`${next.kind}:${next.ref}`);
  } catch (err) {
    await env.DB.prepare("UPDATE social_posts SET status = 'failed', error = ? WHERE id = ?").bind(String(err).slice(0, 300), next.id).run();
    failed.push(`${next.kind}:${next.ref}: ${String(err).slice(0, 160)}`);
  }
  return { posted, failed, skipped: '' };
}

/**
 * The next post to send: among everything due, prefer a kind that has not been posted in the last 24 hours
 * (research, then fact, then article when all are fresh), oldest first within a kind. A long article backlog
 * therefore still leaves room for the daily fact and the research notes.
 */
export async function nextDue(db: D1Database): Promise<SocialPost | null> {
  const due = (
    await db
      .prepare("SELECT * FROM social_posts WHERE status = 'queued' AND scheduled_at <= datetime('now') ORDER BY scheduled_at, id LIMIT 20")
      .all<SocialPost>()
  ).results;
  if (!due.length) return null;
  const recent = new Set(
    (
      await db
        .prepare("SELECT DISTINCT kind FROM social_posts WHERE status = 'posted' AND posted_at >= datetime('now', '-24 hours')")
        .all<{ kind: string }>()
    ).results.map((r) => r.kind),
  );
  const rank = (kind: string) => (recent.has(kind) ? 10 : 0) + (kind === 'research' ? 0 : kind === 'fact' ? 1 : 2);
  return [...due].sort((a, b) => rank(a.kind) - rank(b.kind) || a.scheduled_at.localeCompare(b.scheduled_at) || a.id - b.id)[0];
}

export async function listSocialPosts(db: D1Database, limit = 50): Promise<SocialPost[]> {
  const { results } = await db.prepare('SELECT * FROM social_posts ORDER BY id DESC LIMIT ?').bind(limit).all<SocialPost>();
  return results;
}

export async function setSocialStatus(db: D1Database, id: number, status: 'queued' | 'skipped', scheduledAt?: string): Promise<void> {
  if (scheduledAt) await db.prepare('UPDATE social_posts SET status = ?, scheduled_at = ?, error = NULL WHERE id = ?').bind(status, scheduledAt, id).run();
  else await db.prepare('UPDATE social_posts SET status = ?, error = NULL WHERE id = ?').bind(status, id).run();
}
