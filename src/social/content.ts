/**
 * What the site posts to X, and when. Three kinds, all about the site's own content:
 *   article  - a 3 to 4 post thread for each blog article (once per article)
 *   fact     - a fact from a supplement page, rotating through the catalogue
 *   research - a post per new research note
 *   weekly   - "This week in supplement research": one thread every Sunday with the week's most useful new studies
 *   discoveries - "Discoveries this week": one thread every Wednesday with striking new findings from the leading
 *                 medical and science journals, each stated at its true stage (cells, animals, an early trial)
 * Posts wait in social_posts and go out from the hourly cron on a fixed schedule: X_POSTS_PER_WEEK posts a week (7 in
 * wrangler.jsonc: one a day), each at X_POST_HOUR_UTC on a posting day (see postingPlan). Each kind has its own lane
 * so a backlog of article threads never stops facts or research notes from being drafted, and the sender takes the
 * kinds in turn (the one that went out longest ago first). A failed send is retried once the next day and reported by
 * email (ALERT_EMAIL, else the EMAIL_FROM address) when Resend is configured.
 */
import type { BlogPost } from '../blog';
import { allPosts } from '../blog/store';
import { getMeta, listSupplements, setMeta, type Supplement } from '../db';
import { alertRecipient, sendEmail, type EmailEnv } from '../email';
import { escapeHtml } from '../html';
import { chatJson, useFakeAi, type AiEnv } from '../openai';
import { notePath, pubmedAbstract, pubmedSummaries, pubmedUrl, searchPubmedTerm, unqueuedNotes, type ResearchNote } from '../research';
import { feedItems, type FeedItem } from './feeds';
import { postThread, tweetLength, xEnabled, type XEnv } from './x';

export interface SocialEnv extends AiEnv, XEnv, EmailEnv {
  DB: D1Database;
  CANONICAL_HOST?: string;
  /** "false" keeps posts queued without sending them. */
  X_AUTOPOST?: string;
  /** Posts a week (default 1). Up to 7: one post per posting day at X_POST_HOUR_UTC; more: spread over the daytime window. */
  X_POSTS_PER_WEEK?: string;
  /** Posting days for up to seven posts a week, e.g. "tue" or "tue,fri" (default by count: tue; tue,fri; mon,wed,fri; ...). */
  X_POST_DAYS?: string;
  /** UTC hour of the post on a posting day (default 14: 16:00 in Madrid in summer, 10:00 in New York). */
  X_POST_HOUR_UTC?: string;
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
const MIN_GAP_MINUTES = 150; // between two posts when more than seven a week are spread over the day
const SAME_DAY_HOURS = 22; // a posting day holds one post; 22 rather than 24 so a late cron run keeps the slot
const FAIL_PAUSE_HOURS = 3; // after a failed send, no further attempt for this long
const STALE_RESEARCH_DAYS = 60; // a research note still queued after this long is no longer news
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DEFAULT_DAYS: string[][] = [
  [],
  ['tue'],
  ['tue', 'fri'],
  ['mon', 'wed', 'fri'],
  ['mon', 'tue', 'thu', 'fri'],
  ['mon', 'tue', 'wed', 'thu', 'fri'],
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
  DAY_NAMES,
];

export function siteOrigin(env: SocialEnv): string {
  const host = (env.CANONICAL_HOST ?? '').trim();
  return host ? `https://${host.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}` : 'https://aiww.io';
}

function clampTweet(text: string, max = MAX_TWEET): string {
  let t = text.replace(/\s+/g, ' ').trim();
  while (tweetLength(t) > max) t = t.slice(0, t.length - 10).replace(/\s+\S*$/, '').trim() + '…';
  return t;
}

export async function enqueue(db: D1Database, kind: string, ref: string, tweets: string[], when: Date): Promise<void> {
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
    { tier: 'fast' },
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
    { tier: 'fast' },
  );
  const text = (draft.text ?? '').trim();
  if (!text) throw new Error('empty fact draft');
  return [`${text} ${url}`];
}

const weeklySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intro: { type: 'string', description: 'The opening post, under 200 characters: what this thread is and the one finding most worth a reader\'s minute. No hashtags, no emoji, no URL.' },
    items: {
      type: 'array',
      description: 'Four or five studies, most useful first.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pmid: { type: 'string', description: 'The PMID of the study, exactly as given.' },
          text: { type: 'string', description: 'One post under 200 characters: what the study found, in plain words, with the kind of study and its size when known. No URL.' },
        },
        required: ['pmid', 'text'],
      },
    },
  },
  required: ['intro', 'items'],
} as const;

/** The Sunday (UTC) that closes the week `now` falls in, as YYYY-MM-DD: the key a weekly digest is stored under. */
function weekKey(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ((7 - now.getUTCDay()) % 7)));
  return d.toISOString().slice(0, 10);
}

/**
 * "This week in supplement research": a thread built from the research notes filed in the last seven days. The model
 * chooses the four or five most useful to an ordinary reader; every item links to the note's own page on the site.
 * Null when fewer than three notes were filed.
 */
export async function weeklyDigest(env: SocialEnv): Promise<{ week: string; notes: number; tweets: string[] } | null> {
  const { results: notes } = await env.DB
    .prepare(
      `SELECT n.*, s.name AS supplement_name, s.slug AS supplement_slug FROM research_notes n
       JOIN supplements s ON s.id = n.supplement_id WHERE n.created_at >= datetime('now', '-7 days') AND n.summary != '' ORDER BY n.created_at DESC LIMIT 30`,
    )
    .all<ResearchNote>();
  // A study that already went out in an earlier digest is not offered again.
  const earlier = (await env.DB.prepare("SELECT thread_json FROM social_posts WHERE kind = 'weekly' ORDER BY id DESC LIMIT 6").all<{ thread_json: string }>()).results.map((r) => r.thread_json).join(' ');
  const fresh = notes.filter((n) => !earlier.includes(`/research/${n.pmid}`));
  notes.length = 0;
  notes.push(...fresh);
  if (notes.length < 3) return null;
  const origin = siteOrigin(env);
  const week = weekKey(new Date());
  if (useFakeAi(env)) return { week, notes: notes.length, tweets: ['[Dev mode] This week in supplement research.', ...notes.slice(0, 3).map((n) => `[Dev mode] ${n.title.slice(0, 120)} ${origin}${notePath(n)}`)] };
  const draft = await chatJson<{ intro: string; items: { pmid: string; text: string }[] }>(
    env,
    'weekly_digest',
    weeklySchema,
    [
      `Write this week's thread for X from Wellness Whizz, titled in spirit "This week in supplement research". ${VOICE}`,
      'From the studies below choose the four or five most useful to an ordinary reader who takes supplements. Prefer trials in people and meta-analyses over animal or lab work, and spread the picks over different supplements.',
      'Say plainly when a result is small, early or in a narrow group. Never turn a finding into advice to take something, and give no doses. Use only what each summary says.',
      '',
      ...notes.map((n) => `PMID ${n.pmid} | ${n.supplement_name} | ${n.pub_type || 'study'} | ${n.title}\nSummary: ${n.summary.slice(0, 500)}\nTakeaway: ${n.takeaway.slice(0, 240)}`),
    ].join('\n'),
    { tier: 'fast', maxTokens: 3000 },
  );
  const byPmid = new Map(notes.map((n) => [n.pmid, n]));
  const seen = new Set<string>();
  const items = (draft.items ?? []).filter((i) => byPmid.has(String(i.pmid).trim()) && !seen.has(String(i.pmid).trim()) && seen.add(String(i.pmid).trim()) && String(i.text ?? '').trim()).slice(0, 5);
  if (items.length < 3) throw new Error('weekly digest: fewer than three usable items came back');
  const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}\u2026` : t);
  const tweets = [
    clip(String(draft.intro ?? '').trim() || `This week in supplement research: ${notes.length} new studies read, ${items.length} worth knowing.`, 270),
    ...items.map((i) => `${clip(i.text.trim(), 240)} ${origin}${notePath(byPmid.get(String(i.pmid).trim())!)}`),
    `Every note from this week, in plain language with the source: ${origin}/research`,
  ];
  return { week, notes: notes.length, tweets };
}

/** Where the Wednesday thread looks: the leading general medical and science journals, studies with an abstract. */
const DISCOVERY_TERM =
  '("N Engl J Med"[jour] OR "Lancet"[jour] OR "JAMA"[jour] OR "BMJ"[jour] OR "Nat Med"[jour] OR "Nature"[jour] OR "Science"[jour] OR "Cell"[jour] ' +
  'OR "Ann Intern Med"[jour] OR "JAMA Intern Med"[jour] OR "Lancet Neurol"[jour] OR "Sci Transl Med"[jour] OR "Cell Metab"[jour] OR "Nat Aging"[jour] OR "JAMA Netw Open"[jour]) ' +
  'AND hasabstract AND (Journal Article[pt]) NOT (Editorial[pt] OR Comment[pt] OR Letter[pt] OR News[pt] OR Review[pt])';

const pickSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { pmids: { type: 'array', items: { type: 'string' }, description: 'Up to ten IDs, most striking first, exactly as given.' } },
  required: ['pmids'],
} as const;

/**
 * "Discoveries this week": striking new findings from the leading journals (PubMed) and the week's announcements
 * from regulators, health agencies and journal news desks (src/social/feeds.ts). Titles are screened first, then
 * the abstracts or summaries of the short list are read, so every post rests on what the source itself reports.
 * Null when there is too little material.
 */
export async function discoveriesDigest(env: SocialEnv): Promise<{ week: string; candidates: number; sources: string[]; tweets: string[] } | null> {
  const week = weekKey(new Date());
  if (useFakeAi(env)) return { week, candidates: 0, sources: [], tweets: ['[Dev mode] Discoveries this week.', '[Dev mode] One finding.', '[Dev mode] Another finding.'] };
  const earlier = (await env.DB.prepare("SELECT thread_json FROM social_posts WHERE kind = 'discoveries' ORDER BY id DESC LIMIT 6").all<{ thread_json: string }>()).results.map((r) => r.thread_json).join(' ');
  // Two kinds of candidate: new papers in the leading journals (PubMed) and the week's items from the news feeds.
  const ids = (await searchPubmedTerm(env, DISCOVERY_TERM, 8, 50)).filter((id) => !earlier.includes(`/${id}/`));
  const summaries = await pubmedSummaries(env, ids);
  const news = (await feedItems(8, 6).catch(() => ({ items: [] as FeedItem[] }))).items.filter((i) => i.summary.length >= 120 && !earlier.includes(i.link));
  if (summaries.length + news.length < 6) return null;
  const picked = await chatJson<{ pmids: string[] }>(
    env,
    'discoveries_pick',
    pickSchema,
    [
      'From this week\'s new papers and announcements, pick the ten that an ordinary curious adult would most want to hear about: a real advance in treating or preventing a common condition, a first in humans, a surprising finding about sleep, food, exercise, ageing or the brain, a new technology that worked in a trial, an important safety decision.',
      'Skip health-policy, economics, medical education, case reports, methods papers, product recalls of single batches, staff news and anything too narrow to matter outside a specialty. Spread the picks over different fields and over different sources. Return each ID exactly as given (a number for a paper, or a code like F3-2 for an announcement).',
      '',
      ...summaries.map((s) => `ID ${s.uid} | ${s.source ?? s.fulljournalname ?? ''} | ${s.title}`),
      ...news.map((n) => `ID ${n.id} | ${n.source} | ${n.title}`),
    ].join('\n'),
    { tier: 'screen', maxTokens: 900 },
  );
  const paperById = new Map(summaries.map((s) => [s.uid, s]));
  const newsById = new Map(news.map((n) => [n.id, n]));
  const short = [...new Set((picked.pmids ?? []).map((p) => String(p).replace(/^ID\s+/i, '').trim()))].filter((p) => paperById.has(p) || newsById.has(p)).slice(0, 10);
  const material: { id: string; source: string; title: string; text: string; link: string }[] = [];
  for (const id of short) {
    const n = newsById.get(id);
    if (n) { material.push({ id, source: n.source, title: n.title, text: n.summary, link: n.link }); continue; }
    try {
      const abstract = await pubmedAbstract(env, id);
      const s = paperById.get(id)!;
      if (abstract.length > 300) material.push({ id, source: s.source ?? s.fulljournalname ?? '', title: s.title, text: abstract.slice(0, 1800), link: pubmedUrl(id) });
    } catch (err) {
      console.warn(`discoveries: abstract ${id} failed: ${String(err)}`);
    }
  }
  if (material.length < 3) return null;
  const draft = await chatJson<{ intro: string; items: { pmid: string; text: string }[] }>(
    env,
    'discoveries_digest',
    weeklySchema,
    [
      `Write this week's thread for X from Wellness Whizz about discoveries in medicine and health. ${VOICE}`,
      'Choose the five most striking items below, from at least three different sources. For each, one post: what was found or decided and why it is remarkable, in plain words a friend would repeat. Put the ID of the item, exactly as given, in the pmid field.',
      'Wonder is welcome; exaggeration is not. State the stage honestly in every post (in cells, in mice, a first small trial in people, a large trial, a regulator\'s decision). When the item is an announcement by an agency, name the agency. Never say cure, breakthrough or miracle, never predict when something reaches patients, never give advice. Use only what the text reports, with its own numbers.',
      'The intro post names the thread ("Discoveries this week") and leads with the single most surprising finding.',
      '',
      ...material.map((m) => `ID ${m.id} | ${m.source} | ${m.title}\nText: ${m.text}`),
    ].join('\n'),
    { tier: 'fast', maxTokens: 3000 },
  );
  const byId = new Map(material.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const norm = (v: unknown) => String(v).replace(/^ID\s+/i, '').trim();
  const items = (draft.items ?? []).filter((i) => byId.has(norm(i.pmid)) && !seen.has(norm(i.pmid)) && seen.add(norm(i.pmid)) && String(i.text ?? '').trim()).slice(0, 5);
  if (items.length < 3) throw new Error('discoveries digest: fewer than three usable items came back');
  const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}\u2026` : t);
  const tweets = [
    clip(String(draft.intro ?? '').trim() || 'Discoveries this week, from the leading journals and health agencies.', 270),
    ...items.map((i) => `${clip(i.text.trim(), 240)} ${byId.get(norm(i.pmid))!.link}`),
    `Each link goes to the source itself. For what the evidence says about supplements: ${siteOrigin(env)}/research`,
  ];
  return { week, candidates: summaries.length + news.length, sources: [...new Set(items.map((i) => byId.get(norm(i.pmid))!.source))], tweets };
}

/**
 * Send a digest thread right now, outside the posting schedule (the owner asked for it). `tweets` posts exactly the
 * thread that was previewed; without it a fresh one is written. Recorded like any sent post.
 */
export async function sendWeeklyNow(env: SocialEnv, tweets?: string[], kind: 'weekly' | 'discoveries' = 'weekly'): Promise<{ ok: true; id: string; tweets: string[] } | { ok: false; message: string }> {
  if (!xEnabled(env)) return { ok: false, message: 'X keys are not configured' };
  let thread = (tweets ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
  let week = weekKey(new Date());
  if (thread.length < 3) {
    const digest = kind === 'weekly' ? await weeklyDigest(env) : await discoveriesDigest(env);
    if (!digest) return { ok: false, message: 'too little new material this week' };
    thread = digest.tweets;
    week = digest.week;
  }
  const tooLong = thread.find((t) => tweetLength(t) > 280);
  if (tooLong) return { ok: false, message: `a post is over 280 characters: ${tooLong.slice(0, 60)}` };
  const id = await postThread(env, thread);
  await env.DB
    .prepare("INSERT INTO social_posts (channel, kind, ref, thread_json, scheduled_at, status, posted_at, external_id) VALUES ('x', ?, ?, ?, datetime('now'), 'posted', datetime('now'), ?)")
    .bind(kind, `${week}:now`, JSON.stringify(thread), id)
    .run();
  return { ok: true, id, tweets: thread };
}

// ---------- queue builders (idempotent, run hourly) ----------

export async function buildQueue(env: SocialEnv): Promise<{ queued: string[] }> {
  const queued: string[] = [];
  const now = new Date();
  await env.DB
    .prepare("UPDATE social_posts SET status = 'skipped', error = ? WHERE status = 'queued' AND kind = 'research' AND created_at < datetime('now', ?)")
    .bind(`not sent within ${STALE_RESEARCH_DAYS} days`, `-${STALE_RESEARCH_DAYS} days`)
    .run();
  const pendingByKind = new Map<string, number>();
  for (const row of (await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM social_posts WHERE status = 'queued' GROUP BY kind").all<{ kind: string; n: number }>()).results) {
    pendingByKind.set(row.kind, Number(row.n));
  }
  const pending = (kind: string) => pendingByKind.get(kind) ?? 0;

  // 1. One thread per article, never twice (meta flag); drafted one per run while fewer than three threads wait.
  for (const post of await allPosts(env.DB)) {
    if (pending('article') >= 3) break;
    const flag = `x:article:${post.slug}`;
    if (await getMeta(env.DB, flag)) continue;
    const tweets = await articleThread(env, post);
    await enqueue(env.DB, 'article', post.slug, tweets, now);
    await setMeta(env.DB, flag, now.toISOString());
    queued.push(`article:${post.slug}`);
    break; // one per run; the next hour handles the next article
  }

  // 2. One supplement fact drafted per day while fewer than two wait.
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

  // 3. Research notes: at most two drafted per 7 days and two waiting at a time, regardless of the article backlog.
  const recentResearch = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM social_posts WHERE kind = 'research' AND created_at >= datetime('now', '-7 days')")
    .first<{ n: number }>();
  if ((recentResearch?.n ?? 0) < 2 && pending('research') < 2) {
    for (const note of await unqueuedNotes(env.DB, 1)) {
      const page = `${siteOrigin(env)}/supplement/${note.supplement_slug}`;
      const text = `${note.tweet.trim()} Study: ${pubmedUrl(note.pmid)} Our ${note.supplement_name} profile: ${page}`;
      await enqueue(env.DB, 'research', note.pmid, [text], now);
      await env.DB.prepare('UPDATE research_notes SET queued = 1 WHERE id = ?').bind(note.id).run();
      queued.push(`research:${note.pmid}`);
    }
  }

  // 4. Sunday afternoon (UTC): the week's digest thread, once per week (meta flag).
  if (now.getUTCDay() === 0 && now.getUTCHours() >= 12) {
    const flag = `x:weekly:${weekKey(now)}`;
    if (!(await getMeta(env.DB, flag))) {
      try {
        const digest = await weeklyDigest(env);
        await setMeta(env.DB, flag, now.toISOString());
        if (digest) {
          await enqueue(env.DB, 'weekly', digest.week, digest.tweets, now);
          queued.push(`weekly:${digest.week}`);
        }
      } catch (err) {
        console.error(`weekly digest failed: ${String(err)}`);
      }
    }
  }

  // 5. Wednesday afternoon (UTC): the discoveries thread, once per week (meta flag).
  if (now.getUTCDay() === 3 && now.getUTCHours() >= 12) {
    const flag = `x:discoveries:${weekKey(now)}`;
    if (!(await getMeta(env.DB, flag))) {
      try {
        const digest = await discoveriesDigest(env);
        await setMeta(env.DB, flag, now.toISOString());
        if (digest) {
          await enqueue(env.DB, 'discoveries', digest.week, digest.tweets, now);
          queued.push(`discoveries:${digest.week}`);
        }
      } catch (err) {
        console.error(`discoveries digest failed: ${String(err)}`);
      }
    }
  }
  return { queued };
}

// ---------- posting ----------

export interface PostingPlan {
  per_week: number;
  /** Posting days (three-letter names) when at most one post goes out a day; null when posts are spread over the day. */
  days: string[] | null;
  hour_utc: number;
  per_day: number;
}

/** The schedule from the X_POSTS_PER_WEEK, X_POST_DAYS and X_POST_HOUR_UTC variables. */
export function postingPlan(env: SocialEnv): PostingPlan {
  const perWeek = Math.max(1, Math.round(Number(env.X_POSTS_PER_WEEK ?? '1') || 1));
  if (perWeek > 7) return { per_week: perWeek, days: null, hour_utc: WINDOW_START_UTC, per_day: Math.ceil(perWeek / 7) };
  const hour = Math.min(WINDOW_END_UTC - 1, Math.max(0, Math.floor(Number(env.X_POST_HOUR_UTC ?? '14') || 0)));
  const custom = [...new Set((env.X_POST_DAYS ?? '').toLowerCase().split(/[\s,]+/).map((d) => d.slice(0, 3)).filter((d) => DAY_NAMES.includes(d)))];
  return { per_week: perWeek, days: custom.length ? custom : DEFAULT_DAYS[perWeek], hour_utc: hour, per_day: 1 };
}

export interface SendState {
  ok: boolean;
  /** Why not right now ('' when ok). */
  reason: string;
  last_post_at: string | null;
  /** When the sender may post next (UTC, ISO minutes), 'now' when ok. */
  next_slot: string | null;
}

function parseDb(t: string | null | undefined): number {
  return t ? Date.parse(t.replace(' ', 'T') + 'Z') : 0;
}

function isoMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16) + 'Z';
}

/** Whether the sender may post right now under the plan, and otherwise when. Shared by postDue and the admin page. */
export async function sendState(env: SocialEnv, db: D1Database, now = new Date()): Promise<SendState> {
  const plan = postingPlan(env);
  const last = await db.prepare("SELECT MAX(posted_at) AS t FROM social_posts WHERE status = 'posted'").first<{ t: string | null }>();
  const lastAt = parseDb(last?.t);
  const lastPost = last?.t ?? null;
  const t = now.getTime();
  const hour = now.getUTCHours();
  const lastFail = Date.parse((await getMeta(db, 'social:lastfail')) ?? '') || 0;
  const pausedUntil = lastFail + FAIL_PAUSE_HOURS * 3600_000;

  if (plan.days) {
    // One post per posting day, from the planned hour until the end of the daytime window.
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let slot: number | null = null;
    for (let d = 0; d <= 7 && slot === null; d++) {
      const open = dayStart + d * 86_400_000 + plan.hour_utc * 3600_000;
      const close = dayStart + d * 86_400_000 + WINDOW_END_UTC * 3600_000;
      const date = new Date(open);
      if (!plan.days.includes(DAY_NAMES[date.getUTCDay()])) continue;
      if (close <= t || close <= lastAt + SAME_DAY_HOURS * 3600_000) continue; // over for today, or today's post is out
      slot = Math.max(open, t, lastAt + SAME_DAY_HOURS * 3600_000, pausedUntil);
      if (slot >= close) slot = null; // the pause runs past the window: next posting day
    }
    if (slot === null) return { ok: false, reason: 'no posting day within a week', last_post_at: lastPost, next_slot: null };
    if (slot <= t) return { ok: true, reason: '', last_post_at: lastPost, next_slot: 'now' };
    const reason =
      t < pausedUntil && t >= dayStart + plan.hour_utc * 3600_000 && hour < WINDOW_END_UTC
        ? `paused ${FAIL_PAUSE_HOURS}h after a failed post`
        : lastAt && t - lastAt < SAME_DAY_HOURS * 3600_000
          ? "today's post is out"
          : plan.days.includes(DAY_NAMES[now.getUTCDay()]) && hour < plan.hour_utc
            ? `before the ${String(plan.hour_utc).padStart(2, '0')}:00 UTC slot`
            : 'not a posting day';
    return { ok: false, reason, last_post_at: lastPost, next_slot: isoMinute(slot) };
  }

  // More than seven a week: spread over the daytime window, a cap a day, a minimum gap between two.
  const inWindow = (ms: number) => {
    const h = new Date(ms).getUTCHours();
    return h >= WINDOW_START_UTC && h < WINDOW_END_UTC;
  };
  const toWindow = (ms: number) => {
    if (inWindow(ms)) return ms;
    const d = new Date(ms);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), WINDOW_START_UTC);
    return d.getUTCHours() < WINDOW_START_UTC ? start : start + 86_400_000;
  };
  const recent = await db
    .prepare("SELECT COUNT(*) AS n, MIN(posted_at) AS oldest FROM social_posts WHERE status = 'posted' AND posted_at >= datetime('now', '-24 hours')")
    .first<{ n: number; oldest: string | null }>();
  let candidate = Math.max(t, lastAt + MIN_GAP_MINUTES * 60_000, pausedUntil);
  let reason = '';
  if ((recent?.n ?? 0) >= plan.per_day) {
    candidate = Math.max(candidate, parseDb(recent?.oldest) + 86_400_000);
    reason = 'daily cap reached';
  } else if (t < pausedUntil) reason = `paused ${FAIL_PAUSE_HOURS}h after a failed post`;
  else if (lastAt && t - lastAt < MIN_GAP_MINUTES * 60_000) reason = 'too soon after the last post';
  else if (!inWindow(t)) reason = 'outside posting window';
  candidate = toWindow(candidate);
  if (candidate <= t && !reason) return { ok: true, reason: '', last_post_at: lastPost, next_slot: 'now' };
  return { ok: false, reason: reason || 'outside posting window', last_post_at: lastPost, next_slot: isoMinute(candidate) };
}

export async function postDue(env: SocialEnv): Promise<{ posted: string[]; failed: string[]; skipped: string }> {
  const posted: string[] = [];
  const failed: string[] = [];
  if (env.X_AUTOPOST === 'false') return { posted, failed, skipped: 'X_AUTOPOST=false' };
  if (!xEnabled(env)) return { posted, failed, skipped: 'X keys not configured' };
  const state = await sendState(env, env.DB);
  if (!state.ok) return { posted, failed, skipped: state.reason };

  const next = await nextDue(env.DB);
  if (!next) return { posted, failed, skipped: 'nothing due' };
  try {
    const tweets = JSON.parse(next.thread_json) as string[];
    const id = await postThread(env, tweets);
    await env.DB.prepare("UPDATE social_posts SET status = 'posted', posted_at = datetime('now'), external_id = ?, error = NULL WHERE id = ?").bind(id, next.id).run();
    posted.push(`${next.kind}:${next.ref}`);
  } catch (err) {
    const message = String(err).slice(0, 300);
    // The first failure gets one more try a day later (the error stays visible); the second parks the post as failed.
    const parked = !!next.error;
    if (parked) await env.DB.prepare("UPDATE social_posts SET status = 'failed', error = ? WHERE id = ?").bind(message, next.id).run();
    else await env.DB.prepare("UPDATE social_posts SET scheduled_at = datetime('now', '+1 day'), error = ? WHERE id = ?").bind(message, next.id).run();
    await setMeta(env.DB, 'social:lastfail', new Date().toISOString());
    failed.push(`${next.kind}:${next.ref}: ${message.slice(0, 160)}`);
    await alertFailure(env, next, message, parked);
  }
  return { posted, failed, skipped: '' };
}

/** One email per failed send, through Resend when it is configured; never throws. */
async function alertFailure(env: SocialEnv, post: SocialPost, message: string, parked: boolean): Promise<void> {
  const to = alertRecipient(env);
  if (!to) return;
  const first = (() => {
    try {
      return (JSON.parse(post.thread_json) as string[])[0] ?? '';
    } catch {
      return '';
    }
  })();
  const admin = `${siteOrigin(env)}/api/admin/social?key=<your STATS_KEY>`;
  const nextStep = parked
    ? `This was its second failure, so it is parked as "failed". To try again: ${admin}&action=retry&id=${post.id}`
    : 'It will be tried once more on the next posting day. Nothing to do unless this email comes again.';
  const subject = `X post failed: ${post.kind} ${post.ref}`;
  const text = [`The site could not publish a post on X.`, '', `Post: ${post.kind} ${post.ref} (id ${post.id})`, `Error: ${message}`, '', `First tweet: ${first}`, '', nextStep, '', `Queue and status: ${admin}`].join('\n');
  const html = `<p>The site could not publish a post on X.</p>
<p><b>Post:</b> ${escapeHtml(post.kind)} ${escapeHtml(post.ref)} (id ${post.id})<br><b>Error:</b> ${escapeHtml(message)}</p>
<p style="color:#555">${escapeHtml(first)}</p>
<p>${escapeHtml(nextStep)}</p>
<p>Queue and status: ${escapeHtml(admin)}</p>`;
  try {
    await sendEmail(env, to, subject, html, text);
  } catch (err) {
    console.error(`alert email failed: ${String(err)}`);
  }
}

/**
 * The next post to send: the kind that went out longest ago first (a kind never posted before any other; article,
 * then fact, then research on a tie), the oldest post within that kind. The kinds therefore take turns however
 * long the article backlog is: article, fact, research, article...
 */
export async function nextDue(db: D1Database): Promise<SocialPost | null> {
  const due = (
    await db
      .prepare("SELECT * FROM social_posts WHERE status = 'queued' AND scheduled_at <= datetime('now') ORDER BY scheduled_at, id LIMIT 20")
      .all<SocialPost>()
  ).results;
  if (!due.length) return null;
  const lastByKind = new Map<string, string>();
  for (const row of (await db.prepare("SELECT kind, MAX(posted_at) AS t FROM social_posts WHERE status = 'posted' GROUP BY kind").all<{ kind: string; t: string | null }>()).results) {
    lastByKind.set(row.kind, row.t ?? '');
  }
  const order = ['article', 'fact', 'research'];
  const rank = (kind: string) => (order.includes(kind) ? order.indexOf(kind) : order.length);
  return [...due].sort(
    (a, b) =>
      (lastByKind.get(a.kind) ?? '').localeCompare(lastByKind.get(b.kind) ?? '') ||
      rank(a.kind) - rank(b.kind) ||
      a.scheduled_at.localeCompare(b.scheduled_at) ||
      a.id - b.id,
  )[0];
}

export async function listSocialPosts(db: D1Database, limit = 50): Promise<SocialPost[]> {
  const { results } = await db.prepare('SELECT * FROM social_posts ORDER BY id DESC LIMIT ?').bind(limit).all<SocialPost>();
  return results;
}

export async function setSocialStatus(db: D1Database, id: number, status: 'queued' | 'skipped', scheduledAt?: string): Promise<void> {
  if (scheduledAt) await db.prepare('UPDATE social_posts SET status = ?, scheduled_at = ?, error = NULL WHERE id = ?').bind(status, scheduledAt, id).run();
  else await db.prepare('UPDATE social_posts SET status = ?, error = NULL WHERE id = ?').bind(status, id).run();
}
