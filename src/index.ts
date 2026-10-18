/**
 * Wellness Whizz on Cloudflare Workers.
 *
 *   /                      home page (static export + supplement lists from D1)
 *   /wellness-quiz         static quiz page (served from /public)
 *   POST /api/quiz         replaces the Webflow form + Make.com scenario
 *   GET  /api/session/:id  status of a quiz session
 *   GET  /api/config       public client configuration (Turnstile site key)
 *   POST /api/event        funnel events sent by the browser (quiz views, outbound clicks)
 *   GET  /api/stats        funnel numbers, protected by the STATS_KEY secret
 *   GET  /api/admin/report the Monday numbers email (preview; &send=1 sends it now)
 *   /result/:id            personalised results page
 *   /supplement/:slug      supplement detail page
 *   /sitemap.xml /feed.xml  for search engines and feed readers (src/indexing.ts; the hourly cron pings IndexNow and WebSub)
 */
import { Hono, type Context } from 'hono';
import { supplementSlugsUsed } from './blog';
import { allPosts, findPost, getArticleRow, listArticleRows, parsePost, type ArticleRow } from './blog/store';
import { actOnArticle, articleSummary, asKind, autoQueue, draftNext, enqueueArticle, guessKind, processRow, resendDraftEmail, reviewPage, suggestTopics, tokenOk } from './articles';
import { CONTENT_LANGS, asLang, langFromPath, localizePath, localizeResponse, type Lang } from './i18n';
import { SHELF_MAX_BASE64, SHELF_MAX_IMAGES, SHELF_MEDIA_TYPES, analyzeShelf, countRecentScans, getShelfScan, resolveShelfSupplements, saveShelfScan, shelfEnabled, type ShelfImage, type ShelfMediaType } from './shelf';
import { renderShelfPage, renderShelfResult } from './render/shelf';
import { queueQuizDataArticle, quizDataSummary } from './quizdata';
import { MAX_SINGLE_UPLOAD, connectPage, creatorInfo, disconnect, finishConnect, getAuth, listPosts, postStatus, postVideo, startConnect, tiktokEnabled } from './tiktok';
import { renderTikTokAdmin } from './render/tiktok-admin';
import { getVideo, listVideos, markFailed, markPosted, markReady, nextJob, parseScript, queueVideo, scriptNext } from './videos';
import { actOnProspect, addProspect, checkWins, counts as prospectCounts, dailyOutreach, discoverProspects, draftPending, findContacts, listProspects, noteReply, outreachDigest, outreachStep, recentEvents, sendApproved, type ProspectKind } from './backlinks';
import { renderBacklinksAdmin } from './render/backlinks-admin';
import { renderBacklinksKit } from './render/backlinks-kit';
import DIRECTORIES from '../data/directories.json';
import { createPost as zernioCreatePost, getPost as zernioGetPost, listAccounts as zernioAccounts, uploadVideo as zernioUpload, zernioEnabled } from './zernio';
import {
  getTranslation, hasTranslation, localizePost, localizePosts, localizeSupplement, localizeSupplements, translateBacklog, translateStrings, translationCounts,
  type PostTranslation, type SupplementTranslation,
} from './translate';
import { ensureDatabase } from './bootstrap';
import { MIN_ARTICLE_LENGTH, generateArticle } from './content';
import { generateSupplementProfile } from './openai';
import { generateFaqs } from './faq';
import { generateSupplementImage, imageGenerationEnabled, loadImage, storeImage, supplementsNeedingImage } from './images';
import { attachIherbProducts, supplementsWithoutPhotos } from './products';
import { alertRecipient, emailEnabled, emailStatus, resultsEmail, sendEmail } from './email';
import { weeklyReportEmail } from './report';
import { fileNote, listResearchNotes, pruneAbstractlessNotes, pubmedUrl, repairNotes, researchBatch, type NoteOverrides } from './research';
import { feedXml, indexSync, renderSitemap, sitemapEntries } from './indexing';
import { renderResearchPage } from './render/research';
import { renderSupplementsIndex } from './render/supplements-index';
import { buildQueue, enqueue, listSocialPosts, postDue, postingPlan, sendState, setSocialStatus, siteOrigin } from './social/content';
import { xEnabled } from './social/x';
import {
  EVENT_TYPES, countRecentSessions, countSupplementsNeedingContent, createSession, exportSupplements, getSession,
  getSessionResults, getSupplementBySlug, listSupplements, logEvent, markSession, mergeDuplicateSupplements,
  resolveSupplementSlug, statsSummary, supplementsNeedingContent, updateSupplementContent, type EventInput,
  type EventType, type QuizProfile, type ResultItem, countSupplements, getSupplementsBySlugs, listSupplementNames,
  addSubscriber, contentProgress, countRecentSubscriptions, getMeta, listSubscribers, markSubscriberSent, relatedSupplements, setMeta, weeklyNumbers,
  countSupplementsNeedingFaqs, supplementsNeedingFaqs, updateSupplementFaqs, CATEGORIES, asFormType, insertSupplement, getSupplementByNameKey, normalizeNameKey,
} from './db';
import { runQuizPipeline } from './pipeline';
import { digestStatus, fetchThread, markUsed, parseF5BotAlert, runRedditDigest, screenStep, storeAlert } from './reddit';
import PostalMime from 'postal-mime';
import { renderBlogIndex, renderBlogPost } from './render/blog';
import { fetchAsset, renderHome } from './render/home';
import { renderHowItWorks, renderTerms } from './render/pages';
import { renderFailedPage, renderPendingPage, renderResultPage } from './render/result';
import { renderSupplementPage } from './render/supplement';

export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  /** Claude (src/claude.ts): the key is a secret paid from the plan's API credits; the models are wrangler.jsonc vars. */
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_MODEL_FAST?: string;
  CLAUDE_MODEL_SCREEN?: string;
  LLM_PROVIDER?: string;
  /** Inbound mail (Email Routing -> email() below): the verified destination every message is forwarded to; F5Bot keyword
   *  alerts are kept by the Worker unless MAIL_FORWARD_ALERTS is "true". */
  MAIL_FORWARD_TO?: string;
  MAIL_FORWARD_ALERTS?: string;
  /** The Reddit digest (src/reddit.ts). */
  DIGEST_TO?: string;
  REDDIT_DIGEST?: string;
  REDDIT_MAX_THREADS?: string;
  REDDIT_MAX_REPLIES?: string;
  /** The article pipeline (src/articles.ts): topics queued on its own per week ("0" = off) and the first draft's thinking depth. */
  ARTICLES_PER_WEEK?: string;
  ARTICLE_EFFORT?: string;
  /** Languages the site is served in, e.g. "en,es" (src/i18n.ts); content is translated for every language but en. */
  SITE_LANGS?: string;
  DEV_FAKE_AI?: string;
  PRODUCT_SEARCH_URL?: string;
  IHERB_RCODE?: string;
  RATE_LIMIT_PER_HOUR?: string;
  GLOBAL_LIMIT_PER_HOUR?: string;
  LIST_AI_SUPPLEMENTS?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  STATS_KEY?: string;
  /** TikTok Content Posting API app (sandbox or production) for /api/tiktok/* (src/tiktok.ts). */
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  /** "false" stops published articles from queueing a short video (src/videos.ts). */
  VIDEO_AUTOQUEUE?: string;
  /** Zernio (src/zernio.ts): posts to TikTok, Instagram and others through Zernio's connected accounts. */
  ZERNIO_API_KEY?: string;
  /** Backlink outreach (src/backlinks.ts): pitches per day (default 10, 0 pauses), "true" sends without approval, signature name. */
  OUTREACH_PER_DAY?: string;
  OUTREACH_AUTOSEND?: string;
  OUTREACH_SIGNATURE?: string;
  /** Supplements per cron run of the article writer; "0" disables the scheduled backfill. */
  BACKFILL_BATCH?: string;
  /** "false" turns off generated illustrations for supplements without product photos. */
  IMAGE_GENERATION?: string;
  /** X (Twitter) posting: the four keys of a developer app with read and write permission (src/social/x.ts). */
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;
  /** "false" keeps posts queued without sending them; the schedule comes from the next three (src/social/content.ts). */
  X_AUTOPOST?: string;
  X_POSTS_PER_WEEK?: string;
  X_POST_DAYS?: string;
  X_POST_HOUR_UTC?: string;
  /** Where a "post failed" email and the Monday numbers go (default: the EMAIL_FROM address). */
  ALERT_EMAIL?: string;
  /** Optional NCBI key for faster PubMed requests; RESEARCH_BATCH supplements checked per daily run (default 15) and
   *  RESEARCH_HOURLY per hourly run (default 4, 0 switches the hourly check off). */
  NCBI_API_KEY?: string;
  RESEARCH_BATCH?: string;
  RESEARCH_HOURLY?: string;
  /** Optional: the site's one public hostname (e.g. aiww.io); other hostnames redirect to it. */
  CANONICAL_HOST?: string;
  /** Optional: Resend API key + verified sender for "Email me my results" (src/email.ts). */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  IMAGE_MODEL?: string;
  /** IndexNow key (32 hex characters, served as /<key>.txt); INDEXNOW="false" switches the search-engine pings off. */
  INDEXNOW_KEY?: string;
  INDEXNOW?: string;
}

type AppContext = { Bindings: Bindings };
const app = new Hono<AppContext>();

const AGES = ['<18', '18-25', '26-40', '41-65', '65+'];
const ACTIVITIES = ['Sedentary', 'Lightly Active', 'Moderately Active', 'Very Active', 'Extra Active'];
const SEXES = ['Female', 'Male'];
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** A session still pending after this long has lost its Worker (client disconnected); it is marked failed. */
const PENDING_TIMEOUT_MS = 4 * 60 * 1000;
/** Event types the browser may report; page views and subscriptions are recorded server-side. */
const CLIENT_EVENT_TYPES: readonly EventType[] = ['quiz_view', 'outbound_click', 'share'];

const htmlHeaders = (cacheControl: string) => ({ 'content-type': 'text/html; charset=utf-8', 'cache-control': cacheControl });
const curatedOnly = (env: Bindings) => env.LIST_AI_SUPPLEMENTS === 'false';
/** The languages content is translated into: SITE_LANGS minus English (default en,es). */
const contentLangs = (env: Bindings): Lang[] => (env.SITE_LANGS ?? 'en,es').split(',').map((v) => v.trim()).filter((v): v is Lang => CONTENT_LANGS.includes(v as Lang));
/** DEV_FAKE_AI (canned answers instead of OpenAI) is honoured on localhost only, never on a deployed site. */
const isLocalRequest = (url: string) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname);
/** Turnstile is on only when both the public site key and the secret are configured. */
const turnstileSiteKey = (env: Bindings) => (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : null);

/**
 * One address for the site: "www." is always redirected to the bare domain, and when CANONICAL_HOST is set
 * (e.g. aiww.io) every other hostname, such as the workers.dev address, is redirected to it too. Only page
 * requests are redirected; API calls and the local dev server are left alone.
 */
app.use('*', async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    const url = new URL(c.req.url);
    const canonical = (c.env.CANONICAL_HOST ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    let target: string | null = null;
    if (!isLocalRequest(c.req.url) && !url.pathname.startsWith('/api/') && url.pathname !== '/__scheduled') {
      if (canonical && url.hostname !== canonical) target = canonical;
      else if (!canonical && url.hostname.startsWith('www.')) target = url.hostname.slice(4);
      else if (url.protocol === 'http:') target = url.hostname; // plain HTTP: same host, https
    }
    if (target) {
      url.hostname = target;
      url.protocol = 'https:';
      url.port = '';
      return c.redirect(url.toString(), 301);
    }
  }
  await next();
});

/** Security headers on Worker responses; static assets get the same ones from public/_headers. */
app.use('*', async (c, next) => {
  await next();
  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'SAMEORIGIN',
  };
  if (!isLocalRequest(c.req.url)) headers['strict-transport-security'] = 'max-age=15552000; includeSubDomains';
  try {
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
  } catch {
    c.res = new Response(c.res.body, { status: c.res.status, headers: { ...Object.fromEntries(c.res.headers), ...headers } });
  }
});

// Same security headers as public/_headers applies to the static files; the database is prepared on first use.
app.use('*', async (c, next) => {
  await ensureDatabase(c.env.DB);
  await next();
  const res = new Response(c.res.body, c.res);
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  res.headers.set('x-frame-options', 'SAMEORIGIN');
  c.res = res;
});

// ---------- pages (English, and Spanish under /es/: src/i18n.ts) ----------

/** Register a page under its path and under /es/ with the same handler. */
function pageRoute(path: string, handler: (c: Context<AppContext>, lang: Lang) => Promise<Response> | Response): void {
  app.get(path, (c) => handler(c, 'en'));
  app.get(path === '/' ? '/es' : `/es${path}`, (c) => handler(c, 'es'));
  if (path === '/') app.get('/es/', (c) => handler(c, 'es'));
}

/** The finished page: hreflang links on both versions; in Spanish also the translated chrome and /es/ links. */
function sendPage(c: Context<AppContext>, body: string | Response, lang: Lang, enPath: string, cacheControl: string, alternates = true): Response {
  const res = typeof body === 'string' ? new Response(body, { status: 200, headers: htmlHeaders(cacheControl) }) : body;
  if (lang === 'en' && !alternates) return res;
  return localizeResponse(res, lang, { origin: new URL(c.req.url).origin, path: enPath, alternates });
}

async function localizeResultItems(db: D1Database, lang: Lang, items: ResultItem[]): Promise<ResultItem[]> {
  const sups = await localizeSupplements(db, lang, items.map((i) => i.supplement));
  return items.map((item, i) => ({ ...item, supplement: sups[i] }));
}


pageRoute('/', async (c, lang) => {
  track(c, { type: 'home_view', page: '/' });
  return sendPage(c, await renderHome(c.env, c.req.raw, curatedOnly(c.env), lang), lang, '/', 'public, max-age=60');
});

pageRoute('/wellness-quiz', async (c, lang) => {
  const asset = await fetchAsset(c.env.ASSETS, c.req.raw, '/wellness-quiz');
  if (!asset.ok) return asset;
  return sendPage(c, new Response(asset.body, { status: 200, headers: htmlHeaders('public, max-age=300') }), lang, '/wellness-quiz', 'public, max-age=300');
});

/** Result pages follow the language of the quiz the session came from. */
app.get('/result/:id', async (c) => {
  const id = c.req.param('id');
  if (!SESSION_ID_RE.test(id)) return notFound(c.env, c.req.raw);
  const session = await getSession(c.env.DB, id);
  if (!session) return notFound(c.env, c.req.raw);
  const lang = asLang(session.lang);
  const send = (html: string, cache: string) => sendPage(c, html, lang, `/result/${id}`, cache, false);

  if (session.status === 'pending') {
    const startedAt = Date.parse(session.created_at + 'Z');
    if (Number.isFinite(startedAt) && Date.now() - startedAt > PENDING_TIMEOUT_MS) {
      await markSession(c.env.DB, id, 'failed', 'Timed out while preparing the recommendation');
      return send(renderFailedPage(session), 'no-store');
    }
    return send(renderPendingPage(session), 'no-store');
  }
  if (session.status === 'failed') return send(renderFailedPage(session), 'no-store');

  const items = await getSessionResults(c.env.DB, id);
  if (!items.length) return send(renderFailedPage(session), 'no-store');
  const localized = lang === 'en' ? items : await localizeResultItems(c.env.DB, lang, items);
  track(c, { type: 'result_view', page: `/result/${id}`, session_id: id });
  return send(renderResultPage(session, localized, c.env, { origin: new URL(c.req.url).origin }), 'private, max-age=0, must-revalidate');
});

/** Shareable result images: drawn by the browser on the result page and uploaded (see public/js/share-card.js);
 *  until then the generic brand card is served, marked so the page knows to draw one. */
const MAX_CARD_BYTES = 900_000;
const CARD_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
async function serveResultImage(c: Context<AppContext>, kind: 'card' | 'story'): Promise<Response> {
  const id = c.req.param('id') ?? '';
  if (!SESSION_ID_RE.test(id)) return c.notFound();
  const image = await loadImage(c.env.DB, `result-${id}-${kind}`);
  if (image) {
    return new Response(image.bytes, { headers: { 'content-type': image.contentType, 'cache-control': 'public, max-age=3600', 'x-ww-card': 'generated' } });
  }
  const fallback = await c.env.ASSETS.fetch(new Request(new URL('/images/share-default.jpg', c.req.url)));
  return new Response(fallback.body, {
    status: fallback.ok ? 200 : 404,
    headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-ww-card': 'default' },
  });
}
app.get('/result/:id/card.jpg', (c) => serveResultImage(c, 'card'));
app.get('/result/:id/story.jpg', (c) => serveResultImage(c, 'story'));

function looksLikeImage(b: Uint8Array, type: string): boolean {
  if (type === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8;
  if (type === 'image/png') return b[0] === 0x89 && b[1] === 0x50;
  return b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45; // RIFF....WEBP
}

app.post('/api/result/:id/card', async (c) => {
  const id = c.req.param('id');
  if (!SESSION_ID_RE.test(id)) return c.json({ ok: false }, 400);
  const kind = c.req.query('kind') === 'story' ? 'story' : 'card';
  const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!CARD_TYPES.has(type)) return c.json({ ok: false, error: 'unsupported image type' }, 415);
  if (Number(c.req.header('content-length') ?? '0') > MAX_CARD_BYTES) return c.json({ ok: false, error: 'image too large' }, 413);
  const session = await getSession(c.env.DB, id);
  if (!session || session.status !== 'ready') return c.json({ ok: false }, 404);
  const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
  if (bytes.length > MAX_CARD_BYTES || bytes.length < 2_000 || !looksLikeImage(bytes, type)) return c.json({ ok: false, error: 'not an image' }, 400);
  await storeImage(c.env.DB, `result-${id}-${kind}`, type, bytes);
  return c.json({ ok: true });
});

/** Generated illustrations stored in D1. */
app.get('/images/generated/:file', async (c) => {
  const key = c.req.param('file').replace(/\.(webp|jpe?g|png)$/i, '');
  if (!/^[a-z0-9-]{1,120}$/.test(key)) return c.notFound();
  const image = await loadImage(c.env.DB, key);
  if (!image) return c.notFound();
  return new Response(image.bytes, {
    headers: { 'content-type': image.contentType, 'cache-control': 'public, max-age=86400, stale-while-revalidate=604800' },
  });
});

pageRoute('/supplement/:slug', async (c, lang) => {
  const slug = c.req.param('slug') ?? '';
  const supplement = await getSupplementBySlug(c.env.DB, slug);
  if (!supplement) {
    // Temporary redirect: the catalogue grows, so the mapping of a short slug may change.
    const canonical = await resolveSupplementSlug(c.env.DB, slug);
    return canonical ? c.redirect(localizePath(`/supplement/${canonical}`, lang), 302) : notFound(c.env, c.req.raw);
  }
  // Until its translation exists, a Spanish page shows the English text in the Spanish chrome, noindex and without
  // hreflang links, so links from the Spanish site never dead-end and search engines only see the translated version.
  const translation = lang === 'en' ? null : await getTranslation<SupplementTranslation>(c.env.DB, lang, 'supplement', supplement.slug);
  const pending = lang !== 'en' && !translation;
  const [exploreEn, relatedEn] = await Promise.all([
    listSupplements(c.env.DB, 200, curatedOnly(c.env)),
    relatedSupplements(c.env.DB, supplement, 4, curatedOnly(c.env)),
  ]);
  const [explore, related] = await Promise.all([localizeSupplements(c.env.DB, lang, exploreEn), localizeSupplements(c.env.DB, lang, relatedEn)]);
  const alternates = lang === 'en' ? await hasTranslation(c.env.DB, 'es', 'supplement', supplement.slug) : !pending;
  track(c, { type: 'supplement_view', page: `/supplement/${supplement.slug}`, slug: supplement.slug });
  const html = renderSupplementPage(localizeSupplement(supplement, translation), explore, c.env, { related, origin: new URL(c.req.url).origin });
  const body = pending ? new Response(html, { status: 200, headers: { ...htmlHeaders('public, max-age=60'), 'x-robots-tag': 'noindex' } }) : html;
  return sendPage(c, body, lang, `/supplement/${supplement.slug}`, 'public, max-age=300', alternates);
});

// ---------- editorial pages ----------

pageRoute('/how-it-works', async (c, lang) => {
  const n = await countSupplements(c.env.DB);
  track(c, { type: 'page_view', page: '/how-it-works' });
  return sendPage(c, renderHowItWorks(n, new URL(c.req.url).origin), lang, '/how-it-works', 'public, max-age=600');
});

// Dedicated privacy-policy URL for app directories (TikTok, X, etc.): the policy lives in the terms page.
app.get('/privacy', (c) => c.redirect('/terms#privacy', 301));
app.get('/es/privacy', (c) => c.redirect('/es/terms#privacy', 301));
pageRoute('/terms', (c, lang) => {
  track(c, { type: 'page_view', page: '/terms' });
  return sendPage(c, renderTerms(new URL(c.req.url).origin), lang, '/terms', 'public, max-age=600');
});

pageRoute('/blog', async (c, lang) => {
  const posts = await localizePosts(c.env.DB, lang, await allPosts(c.env.DB));
  const supplements = await getSupplementsBySlugs(c.env.DB, posts.map((p) => p.heroSupplement));
  track(c, { type: 'page_view', page: '/blog' });
  const ctx = { env: c.env, origin: new URL(c.req.url).origin, supplements };
  return sendPage(c, renderBlogIndex(ctx, posts), lang, '/blog', 'public, max-age=600');
});

/** Articles: bundled or published from the pipeline. ?preview=<draft token> shows a draft (noindex, uncached). */
pageRoute('/blog/:slug', async (c, lang) => {
  const slug = c.req.param('slug') ?? '';
  const posts = await allPosts(c.env.DB);
  let post = posts.find((p) => p.slug === slug);
  let preview = false;
  const token = c.req.query('preview');
  if (token && lang === 'en') {
    const row = await getArticleRow(c.env.DB, slug);
    const draft = tokenOk(row, token) ? parsePost(row.draft_json) ?? parsePost(row.post_json) : null;
    if (draft) {
      post = draft;
      preview = true;
    }
  }
  if (!post) return notFound(c.env, c.req.raw);
  let pending = false;
  if (lang !== 'en') {
    const translation = await getTranslation<PostTranslation>(c.env.DB, lang, 'post', slug);
    if (translation) post = localizePost(post, translation);
    else pending = true; // English text in the Spanish chrome, noindex, until the translation exists
  }
  const related = await localizePosts(c.env.DB, lang, posts.filter((p) => p.slug !== slug).slice(0, 3));
  const supplementsEn = await getSupplementsBySlugs(c.env.DB, [...supplementSlugsUsed(post), ...related.map((p) => p.heroSupplement)]);
  const supplements = new Map((await localizeSupplements(c.env.DB, lang, [...supplementsEn.values()])).map((sup) => [sup.slug, sup]));
  const ctx = { env: c.env, origin: new URL(c.req.url).origin, supplements };
  let html = renderBlogPost(ctx, post, related);
  if (preview) {
    const banner = '<div style="position:sticky;top:0;z-index:50;background:#b00020;color:#fff;text-align:center;padding:8px 12px;font:600 14px Arial,sans-serif">Draft preview. Not public until you publish it from the review page.</div>';
    html = html.replace('<div class="ww-progress"', `${banner}<div class="ww-progress"`);
    return c.body(html, 200, { ...htmlHeaders('no-store'), 'x-robots-tag': 'noindex, nofollow' });
  }
  const alternates = lang === 'en' ? await hasTranslation(c.env.DB, 'es', 'post', slug) : !pending;
  track(c, { type: 'page_view', page: `/blog/${post.slug}`, slug: `blog:${post.slug}` });
  const body = pending ? new Response(html, { status: 200, headers: { ...htmlHeaders('public, max-age=60'), 'x-robots-tag': 'noindex' } }) : html;
  return sendPage(c, body, lang, `/blog/${post.slug}`, 'public, max-age=600', alternates);
});

/** robots.txt with an absolute sitemap URL (a relative one is ignored by search engines). */
app.get('/robots.txt', (c) => {
  const origin = new URL(c.req.url).origin;
  // Result pages stay out of search indexes, but the link-preview crawlers may read them for the share card.
  const previewBots = ['Twitterbot', 'facebookexternalhit', 'Facebot', 'WhatsApp', 'LinkedInBot', 'TelegramBot', 'Slackbot-LinkExpanding', 'Discordbot'];
  const body = [
    'User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /result/', '',
    ...previewBots.flatMap((bot) => [`User-agent: ${bot}`, 'Allow: /', 'Disallow: /api/', '']),
    `Sitemap: ${origin}/sitemap.xml`, '',
  ].join('\n');
  return c.body(body, 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
});

/** llms.txt (llmstxt.org): a plain-text map of the site for AI assistants and their crawlers. */
app.get('/llms.txt', async (c) => {
  const origin = new URL(c.req.url).origin;
  const supplements = await listSupplements(c.env.DB, 500, curatedOnly(c.env));
  const clip = (text: string) => (text.length > 160 ? `${text.slice(0, 157).replace(/\s+\S*$/, '')}…` : text);
  const line = (name: string, path: string, text?: string | null) =>
    `- [${name}](${origin}${path})${text?.trim() ? `: ${clip(text.replace(/\s+/g, ' ').trim())}` : ''}`;
  const body = [
    '# Wellness Whizz',
    '',
    '> Wellness Whizz is a free AI supplement advisor: a two-minute quiz turns your goals, diet and lifestyle into a personalised, evidence-based supplement plan, and every supplement in the catalogue has a guide covering benefits, dosage, contraindications, interactions, studies and where to buy.',
    '',
    'Educational content only, not medical advice. Product links are iHerb affiliate links.',
    '',
    '## Start here',
    line('Take the quiz', '/', 'A personalised supplement plan in about two minutes.'),
    line('How it works', '/how-it-works', 'How the recommendation engine scores supplements.'),
    line('All supplements', '/supplements', `Index of all ${supplements.length} supplement guides, grouped by category.`),
    line('Blog', '/blog', 'Evidence-first guides to choosing supplements.'),
    line('Research notes', '/research', 'Plain-language summaries of recent human trials and reviews.'),
    line('Terms, privacy and affiliate disclosure', '/terms'),
    '',
    '## Articles',
    ...(await allPosts(c.env.DB)).map((p) => line(p.title, `/blog/${p.slug}`, p.description)),
    '',
    '## Supplement guides',
    ...supplements.map((s) => line(s.name, `/supplement/${s.slug}`, s.summary)),
    '',
  ].join('\n');
  return c.body(body, 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
});

pageRoute('/supplements', async (c, lang) => {
  const supplements = await localizeSupplements(c.env.DB, lang, await listSupplements(c.env.DB, 500, curatedOnly(c.env)));
  track(c, { type: 'page_view', page: '/supplements' });
  return sendPage(c, renderSupplementsIndex(supplements, new URL(c.req.url).origin), lang, '/supplements', 'public, max-age=600');
});

/** Research notes stay in English for now; the Spanish page has the Spanish chrome around them. */
pageRoute('/research', async (c, lang) => {
  const notes = await listResearchNotes(c.env.DB, 100);
  track(c, { type: 'page_view', page: '/research' });
  return sendPage(c, renderResearchPage(notes, new URL(c.req.url).origin), lang, '/research', 'public, max-age=600');
});

// ---------- shelf scan (src/shelf.ts) ----------

pageRoute('/shelf', (c, lang) => {
  track(c, { type: 'page_view', page: '/shelf' });
  return sendPage(c, renderShelfPage(new URL(c.req.url).origin), lang, '/shelf', 'public, max-age=600');
});

/** The photos come as base64 JSON (resized in the browser, public/js/shelf.js); the answer is the result page's URL. */
app.post('/api/shelf', async (c) => {
  const body = await readJson(c.req.raw);
  const env: Bindings = { ...c.env, DEV_FAKE_AI: isLocalRequest(c.req.url) ? c.env.DEV_FAKE_AI : undefined };
  if (!shelfEnabled(env)) return c.json({ error: 'The shelf scan is not configured yet.' }, 503);
  const raw = Array.isArray(body.images) ? body.images.slice(0, SHELF_MAX_IMAGES) : [];
  const images: ShelfImage[] = [];
  for (const item of raw as { media_type?: unknown; data?: unknown }[]) {
    const mediaType = String(item?.media_type ?? '') as ShelfMediaType;
    const data = String(item?.data ?? '').replace(/^data:[^,]*,/, '');
    if (!SHELF_MEDIA_TYPES.includes(mediaType) || !/^[A-Za-z0-9+/=\s]+$/.test(data) || data.length < 100) continue;
    if (data.length > SHELF_MAX_BASE64) return c.json({ error: 'A photo is too large. Please try again; the page resizes photos before sending them.' }, 413);
    images.push({ media_type: mediaType, data: data.replace(/\s+/g, '') });
  }
  if (!images.length) return c.json({ error: 'Please add at least one photo of your supplements.' }, 400);
  const goal = String(body.goal ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const lang = asLang(body.lang);

  const ipHash = await hashIp(c.req.header('cf-connecting-ip') ?? '');
  const perIp = Number(c.env.RATE_LIMIT_PER_HOUR ?? '10');
  if (ipHash && perIp > 0 && (await countRecentScans(c.env.DB, ipHash, 1)) >= perIp) return c.json({ error: 'Too many scans from this network. Please try again later.' }, 429);
  const global = Number(c.env.GLOBAL_LIMIT_PER_HOUR ?? '100');
  if (global > 0 && (await countRecentScans(c.env.DB, null, 1)) >= global) return c.json({ error: 'The advisor is very busy right now. Please try again in a little while.' }, 429);

  try {
    const analysis = await analyzeShelf(env, images, goal, lang, await listSupplementNames(c.env.DB, 300));
    await resolveShelfSupplements(c.env.DB, analysis);
    const id = await saveShelfScan(c.env.DB, { lang, goal, ipHash, analysis });
    return c.json({ id, url: `/shelf/${id}`, products: analysis.products.length });
  } catch (err) {
    console.error(`shelf scan failed: ${String(err)}`);
    return c.json({ error: 'We could not read the photos this time. Please try again.' }, 500);
  }
});

/** The result page follows the language the scan was made in; it is never indexed. */
app.get('/shelf/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f]{24}$/.test(id)) return notFound(c.env, c.req.raw);
  const scan = await getShelfScan(c.env.DB, id);
  if (!scan) return notFound(c.env, c.req.raw);
  const lang = asLang(scan.lang);
  const slugs = [...scan.analysis.products.map((p) => p.slug), ...scan.analysis.missing.map((m) => m.slug)].filter((s): s is string => !!s);
  const supplementsEn = await getSupplementsBySlugs(c.env.DB, slugs);
  const supplements = new Map((await localizeSupplements(c.env.DB, lang, [...supplementsEn.values()])).map((sup) => [sup.slug, sup]));
  track(c, { type: 'page_view', page: `/shelf/${id}` });
  const body = new Response(renderShelfResult(scan, supplements, c.env, new URL(c.req.url).origin), { status: 200, headers: { ...htmlHeaders('private, max-age=0, must-revalidate'), 'x-robots-tag': 'noindex' } });
  return sendPage(c, body, lang, `/shelf/${id}`, 'private, max-age=0, must-revalidate', false);
});

/** Owner-only: the X queue (what was posted, what is waiting, what failed) and simple controls. */
app.get('/api/admin/social', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  c.header('cache-control', 'no-store');
  const action = c.req.query('action');
  const id = Number(c.req.query('id') ?? '');
  if (action && Number.isFinite(id) && id > 0) {
    if (action === 'skip') await setSocialStatus(c.env.DB, id, 'skipped');
    else if (action === 'retry') await setSocialStatus(c.env.DB, id, 'queued', new Date().toISOString().slice(0, 19).replace('T', ' '));
  }
  if (action === 'build') {
    await pruneAbstractlessNotes(c.env.DB);
    const built = await buildQueue(c.env);
    return c.json({ built, posts: await listSocialPosts(c.env.DB) });
  }
  if (action === 'post') return c.json({ result: await postDue(c.env), posts: await listSocialPosts(c.env.DB) });
  if (action === 'research') {
    const sups = await listSupplements(c.env.DB, 500, true);
    const pruned = await pruneAbstractlessNotes(c.env.DB);
    const result = await researchBatch(c.env, sups.sort(() => Math.random() - 0.5), 5);
    const repaired = await repairNotes(c.env, 10);
    return c.json({ pruned, result, repaired, notes: (await listResearchNotes(c.env.DB, 10)).length });
  }
  // "Why is nothing going out?" is the usual question, so the listing says what the sender would do right now.
  const plan = postingPlan(c.env);
  const state = await sendState(c.env, c.env.DB);
  const lastRun = await getMeta(c.env.DB, 'social:last');
  const posting = {
    x_keys_configured: xEnabled(c.env),
    // Last characters only, to compare with "Reveal API Key hint" in the X developer portal.
    x_api_key_hint: c.env.X_API_KEY ? `…${c.env.X_API_KEY.slice(-4)}` : null,
    x_access_token_hint: c.env.X_ACCESS_TOKEN ? `${c.env.X_ACCESS_TOKEN.slice(0, 6)}…${c.env.X_ACCESS_TOKEN.slice(-4)}` : null,
    autopost: c.env.X_AUTOPOST !== 'false',
    posts_per_week: plan.per_week,
    posting_days: plan.days,
    post_hour_utc: plan.days ? plan.hour_utc : null,
    now_utc: new Date().toISOString().slice(0, 16) + 'Z',
    can_post_now: state.ok,
    why_not_now: state.ok ? null : state.reason,
    last_post_at: state.last_post_at,
    next_slot_utc: state.next_slot,
    alert_email: alertRecipient(c.env),
    last_hourly_run: lastRun ? JSON.parse(lastRun) : null,
  };
  return c.json({ posting, posts: await listSocialPosts(c.env.DB) });
});

app.get('/sitemap.xml', async (c) => {
  const entries = await sitemapEntries(c.env.DB, curatedOnly(c.env), contentLangs(c.env));
  const xml = renderSitemap(new URL(c.req.url).origin, entries);
  return c.body(xml, 200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' });
});

/** RSS feed of the articles and research notes; every page's <head> links it and the hourly cron announces changes to Google's WebSub hub. */
app.get('/feed.xml', async (c) => {
  const xml = await feedXml(c.env.DB, new URL(c.req.url).origin);
  return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=600' });
});

// ---------- API ----------

app.get('/api/config', (c) => {
  c.header('cache-control', 'public, max-age=300');
  return c.json({ turnstileSiteKey: turnstileSiteKey(c.env) });
});

app.post('/api/quiz', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? await readJson(c.req.raw) : await readForm(c.req.raw);
  const wantsHtml = !isJson && (c.req.header('accept') ?? '').includes('text/html');
  const reject = (status: 400 | 429 | 503, message: string) =>
    wantsHtml ? c.body(message, status, { 'content-type': 'text/plain; charset=utf-8' }) : c.json({ error: message }, status);

  const validation = validateProfile(body);
  if (!validation.ok) return reject(400, validation.error);
  const env: Bindings = { ...c.env, DEV_FAKE_AI: isLocalRequest(c.req.url) ? c.env.DEV_FAKE_AI : undefined };
  if (!env.OPENAI_API_KEY && env.DEV_FAKE_AI !== 'true') {
    return reject(503, 'The advisor is not configured yet: the site owner must add the OPENAI_API_KEY secret in Cloudflare.');
  }

  const ip = c.req.header('cf-connecting-ip') ?? '';
  if (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) {
    const token = String(body['cf-turnstile-response'] ?? '');
    if (!token || !(await verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, ip))) {
      return reject(400, 'Verification failed. Please reload the page and try again.');
    }
  }

  const requestedId = String(body.sessionID ?? body.sessionId ?? '');
  const id = SESSION_ID_RE.test(requestedId) ? requestedId : newSessionId();
  const existingResponse = async () => {
    const existing = await getSession(c.env.DB, id);
    const status = existing?.status ?? 'pending';
    return wantsHtml ? c.redirect(`/result/${id}`, 303) : c.json({ id, status, url: `/result/${id}` });
  };

  // Re-submits with the same id (double click, retry after a dropped connection) reuse the session.
  if (await getSession(c.env.DB, id)) return existingResponse();

  const ipHash = await hashIp(ip);
  const perIpLimit = Number(c.env.RATE_LIMIT_PER_HOUR ?? '10');
  if (ipHash && perIpLimit > 0 && (await countRecentSessions(c.env.DB, ipHash, 1)) >= perIpLimit) {
    return reject(429, 'Too many requests from this network. Please try again later.');
  }
  const globalLimit = Number(c.env.GLOBAL_LIMIT_PER_HOUR ?? '100');
  if (globalLimit > 0 && (await countRecentSessions(c.env.DB, null, 1)) >= globalLimit) {
    return reject(429, 'The advisor is very busy right now. Please try again in a little while.');
  }

  const lang = asLang(body.lang);
  if (!(await createSession(c.env.DB, id, validation.profile, ipHash, lang))) return existingResponse(); // lost a race

  // The browser stays connected while the pipeline runs; waitUntil covers a short disconnect at the end.
  const work = runQuizPipeline(env, id, validation.profile, (job) => c.executionCtx.waitUntil(job), lang).then(
    () => 'ready' as const,
    () => 'failed' as const,
  );
  c.executionCtx.waitUntil(work);
  const status = await work;

  if (wantsHtml) return c.redirect(`/result/${id}`, 303);
  if (status === 'failed') {
    return c.json({ id, status, url: `/result/${id}`, error: 'We could not prepare your recommendation. Please try again.' }, 500);
  }
  return c.json({ id, status, url: `/result/${id}` });
});

app.get('/api/session/:id', async (c) => {
  const id = c.req.param('id');
  if (!SESSION_ID_RE.test(id)) return c.json({ error: 'Not found' }, 404);
  const session = await getSession(c.env.DB, id);
  if (!session) return c.json({ error: 'Not found' }, 404);
  c.header('cache-control', 'no-store');
  return c.json({ id, status: session.status, url: `/result/${id}`, created_at: session.created_at });
});

/** Browser-reported events (sent with navigator.sendBeacon from site.js / quiz.js). */
app.post('/api/event', async (c) => {
  const body = await readJson(c.req.raw);
  const type = String(body.type ?? '') as EventType;
  if (!CLIENT_EVENT_TYPES.includes(type)) return c.json({ ok: false }, 400);
  const text = (key: string, max: number) => {
    const value = String(body[key] ?? '').trim().slice(0, max);
    return value || null;
  };
  let target: string | null = null;
  try {
    const href = String(body.href ?? '');
    if (href) target = new URL(href).hostname.slice(0, 120);
  } catch {
    target = null;
  }
  track(c, { type, slug: text('slug', 120), product: text('product', 200), page: text('page', 200), target, session_id: text('session', 64) });
  return c.json({ ok: true });
});

/** Email capture: "Email me my results" (sends the list when Resend is configured) and the newsletter box. */
app.post('/api/subscribe', async (c) => {
  const body = await readJson(c.req.raw);
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return c.json({ error: 'Please enter a valid email address.' }, 400);
  const source = body.source === 'results' ? 'results' : 'newsletter';
  const sessionId = typeof body.session_id === 'string' && SESSION_ID_RE.test(body.session_id) ? body.session_id : null;
  const ipHash = await hashIp(c.req.header('cf-connecting-ip') ?? '');
  if ((await countRecentSubscriptions(c.env.DB, ipHash)) >= 5) return c.json({ error: 'Too many requests, please try again later.' }, 429);

  await addSubscriber(c.env.DB, { email, source, session_id: sessionId, ip_hash: ipHash });
  track(c, { type: 'subscribe', slug: source, page: typeof body.page === 'string' ? body.page.slice(0, 200) : null, session_id: sessionId });

  if (source === 'results' && sessionId && emailEnabled(c.env)) {
    const [session, items] = await Promise.all([getSession(c.env.DB, sessionId), getSessionResults(c.env.DB, sessionId)]);
    if (session && items.length) {
      const mail = resultsEmail(c.env, new URL(c.req.url).origin, session, items);
      c.executionCtx.waitUntil(
        sendEmail(c.env, email, mail.subject, mail.html, mail.text)
          .then(() => markSubscriberSent(c.env.DB, email))
          .catch((err) => console.error(`results email failed: ${String(err)}`)),
      );
      return c.json({ ok: true, message: 'Sent. Check your inbox (and the spam folder) in a minute.' });
    }
  }
  return c.json({
    ok: true,
    message: source === 'results' ? 'Saved. We will email this list to you shortly.' : 'Thank you, you are on the list.',
  });
});

/** Owner-only: the subscriber list as CSV (default) or JSON (?format=json). */
app.get('/api/admin/subscribers', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  const rows = await listSubscribers(c.env.DB);
  c.header('cache-control', 'no-store');
  if (c.req.query('format') === 'json') return c.json({ count: rows.length, subscribers: rows });
  const csv = ['email,source,session_id,created_at,last_sent_at,unsubscribed_at']
    .concat(rows.map((r) => [r.email, r.source, r.session_id ?? '', r.created_at, r.last_sent_at ?? '', r.unsubscribed_at ?? ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')))
    .join('\n');
  return c.body(csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="subscribers.csv"' });
});

/** Owner-only routes: require the STATS_KEY secret as ?key= or a bearer token. */
function authorized(c: { env: Bindings; req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }): Response | null {
  const key = c.env.STATS_KEY;
  if (!key) return Response.json({ error: 'Not found' }, { status: 404 });
  const provided = c.req.query('key') ?? (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!provided || provided !== key) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return null;
}

app.get('/api/stats', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  c.header('cache-control', 'no-store');
  const [stats, content, lastCron, lastSocial, lastResearch, lastReport, lastIndexing] = await Promise.all([
    statsSummary(c.env.DB),
    contentProgress(c.env.DB, MIN_ARTICLE_LENGTH),
    getMeta(c.env.DB, 'cron:last'),
    getMeta(c.env.DB, 'social:last'),
    getMeta(c.env.DB, 'research:last'),
    getMeta(c.env.DB, 'report:last'),
    getMeta(c.env.DB, 'indexing:last'),
  ]);
  return c.json({
    ...stats,
    content: { ...content, last_cron: parseMeta(lastCron) },
    social: { last_run: parseMeta(lastSocial) },
    research: { last_run: parseMeta(lastResearch) },
    report: { last_sent: parseMeta(lastReport) },
    indexing: { last_submission: parseMeta(lastIndexing) },
  });
});

/** Meta values are JSON written by the crons; an old plain value is returned as is. */
function parseMeta(value: string | null): unknown {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return value;
  }
}

/** The Monday numbers email for the current week. */
async function weeklyReport(env: Bindings): Promise<{ subject: string; html: string; text: string }> {
  const [numbers, content] = await Promise.all([weeklyNumbers(env.DB), contentProgress(env.DB, MIN_ARTICLE_LENGTH)]);
  return weeklyReportEmail(siteOrigin(env), numbers, content);
}

/**
 * Owner-only: the Monday numbers email as the cron would send it. ?format=html shows it; &send=1 sends it now
 * (&to=<address> to somewhere else); &status=1 asks Resend what became of the last one (needs a full-access key).
 */
app.get('/api/admin/report', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  c.header('cache-control', 'no-store');
  const last = parseMeta(await getMeta(c.env.DB, 'report:last')) as { id?: string } | null;
  if (c.req.query('status') === '1') {
    if (!last?.id) return c.json({ error: 'No report has been sent yet (or the last send has no Resend id).' }, 404);
    try {
      return c.json({ last_sent: last, resend: await emailStatus(c.env, last.id) });
    } catch (err) {
      // A "sending access" API key cannot read a message back; the Resend answer says so.
      return c.json({ last_sent: last, error: String(err).slice(0, 300) }, 502);
    }
  }
  const mail = await weeklyReport(c.env);
  // &to=<address> sends this one copy somewhere else (a colleague, or a delivery test); the cron keeps its address.
  const override = (c.req.query('to') ?? '').trim().toLowerCase();
  const to = (EMAIL_RE.test(override) ? override : null) ?? alertRecipient(c.env);
  if (c.req.query('send') === '1') {
    if (!to) return c.json({ error: 'Email is not configured (RESEND_API_KEY and EMAIL_FROM).' }, 400);
    const id = await sendEmail(c.env, to, mail.subject, mail.html, mail.text);
    await setMeta(c.env.DB, 'report:last', JSON.stringify({ at: new Date().toISOString(), to, subject: mail.subject, id, manual: true }));
    return c.json({ sent: true, to, subject: mail.subject, id });
  }
  if (c.req.query('format') === 'html') return c.html(mail.html);
  return c.json({ to, subject: mail.subject, text: mail.text, last_sent: last });
});

/**
 * Owner-only: add a supplement by name (the quiz pipeline's profile writer, then iHerb products). The article, FAQ and
 * photo backfills pick it up on their next runs. ?name=Glycine&category=Amino%20Acid&form=powder
 */
app.get('/api/admin/supplement', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  c.header('cache-control', 'no-store');
  const name = (c.req.query('name') ?? '').trim();
  if (name.length < 2 || name.length > 80) return c.json({ error: 'name (2-80 characters) is required' }, 400);
  const category = CATEGORIES.includes(c.req.query('category') ?? '') ? (c.req.query('category') as string) : 'Other';
  const rec = { name, category, form_type: asFormType(c.req.query('form')), reason: '' };
  const before = await getSupplementByNameKey(c.env.DB, normalizeNameKey(name));
  if (before) return c.json({ created: false, slug: before.slug, name: before.name, category: before.category, page: `${siteOrigin(c.env)}/supplement/${before.slug}` });
  const sup = await insertSupplement(c.env.DB, await generateSupplementProfile(c.env, rec), 'ai');
  let products = 0;
  try {
    products = await attachIherbProducts(c.env, sup);
  } catch (err) {
    console.error(`iHerb products for ${sup.slug} failed: ${String(err)}`);
  }
  return c.json({ created: true, slug: sup.slug, name: sup.name, category: sup.category, products, page: `${siteOrigin(c.env)}/supplement/${sup.slug}` });
});

/**
 * Owner-only: file one PubMed paper as a research note under a supplement. GET ?pmid=…&slug=… lets the model draft it
 * from the abstract; POST with a JSON body {pmid, slug, summary, takeaway, tweet, title?, journal?, pub_date?,
 * pub_type?} files the given text. &queue=1 (or "queue": true) also queues the X post now; &post=<blog slug> makes
 * that post link the article instead of the supplement profile.
 */
app.on(['GET', 'POST'], '/api/admin/note', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  c.header('cache-control', 'no-store');
  const body = c.req.method === 'POST' ? await readJson(c.req.raw) : {};
  const param = (k: string) => {
    const v = body[k] ?? c.req.query(k);
    return typeof v === 'string' ? v.trim() : '';
  };
  const pmid = param('pmid').replace(/\D/g, '');
  const slug = param('slug');
  if (!pmid || !slug) return c.json({ error: 'pmid and slug are required' }, 400);
  const sup = (await getSupplementBySlug(c.env.DB, slug)) ?? (await getSupplementBySlug(c.env.DB, (await resolveSupplementSlug(c.env.DB, slug)) ?? ''));
  if (!sup) return c.json({ error: `No supplement with slug ${slug}` }, 404);
  const overrides: NoteOverrides = {};
  for (const k of ['summary', 'takeaway', 'tweet', 'title', 'journal', 'pub_date', 'pub_type'] as const) if (param(k)) overrides[k] = param(k);
  const result = await fileNote(c.env, sup, pmid, overrides);
  const queue = param('queue') === '1' || body.queue === true;
  let queued: string | null = null;
  if (queue) {
    const already = await c.env.DB.prepare("SELECT 1 AS x FROM social_posts WHERE kind = 'research' AND ref = ? AND status IN ('queued', 'posted')").bind(pmid).first();
    if (!already) {
      const postSlug = param('post');
      const link = postSlug && (await findPost(c.env.DB, postSlug)) ? `Our write-up: ${siteOrigin(c.env)}/blog/${postSlug}` : `Our ${sup.name} profile: ${siteOrigin(c.env)}/supplement/${sup.slug}`;
      queued = `${(result.note.tweet ?? '').trim()} Study: ${pubmedUrl(pmid)} ${link}`;
      await enqueue(c.env.DB, 'research', pmid, [queued], new Date());
      await c.env.DB.prepare('UPDATE research_notes SET queued = 1 WHERE pmid = ?').bind(pmid).run();
    }
  }
  return c.json({ added: result.added, supplement: sup.slug, note: result.note, queued, page: `${siteOrigin(c.env)}/research` });
});

/**
 * Owner-only: tell the search engines about changed pages now (the hourly cron does the same). Without parameters
 * only what changed since the last run is submitted; &all=1 submits every page in the sitemap, &urls=/a,/b adds
 * specific paths, &dry=1 shows the list without sending or recording anything.
 */
app.get('/api/admin/indexnow', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  c.header('cache-control', 'no-store');
  const paths = (c.req.query('urls') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const result = await indexSync(c.env, { all: c.req.query('all') === '1', dry: c.req.query('dry') === '1', paths, curatedOnly: curatedOnly(c.env) });
  return c.json(result);
});

/** Write missing articles now (the cron does the same a few at a time). ?limit=N, default 3. */
app.get('/api/admin/backfill', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  const limit = Math.min(10, Math.max(1, Number(c.req.query('limit') ?? '3') || 3));
  c.header('cache-control', 'no-store');
  const merged = await mergeDuplicateSupplements(c.env.DB);
  const content = await backfillContent(c.env, limit);
  const faqs = await backfillFaqs(c.env, limit);
  const photos = await backfillProductPhotos(c.env, Math.min(limit, 3));
  const images = await backfillImages(c.env, Math.min(limit, 3));
  return c.json({ ...content, merged: merged.merged, faqs, photos, illustrations: images });
});

/** Write "Common Questions" blocks now: ?limit=N (default 3) for the next supplements without one, or ?slug=X to (re)write one page. */
app.get('/api/admin/faq', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  c.header('cache-control', 'no-store');
  const slug = c.req.query('slug');
  if (slug) {
    const sup = await getSupplementBySlug(c.env.DB, slug);
    if (!sup) return c.json({ error: 'Unknown supplement' }, 404);
    const faqs = await generateFaqs(c.env, sup);
    await updateSupplementFaqs(c.env.DB, sup.id, faqs);
    return c.json({ slug: sup.slug, faqs });
  }
  const limit = Math.min(10, Math.max(1, Number(c.req.query('limit') ?? '3') || 3));
  return c.json(await backfillFaqs(c.env, limit));
});

/** The whole catalogue as JSON, in the shape of data/supplements.json (to bundle AI-written content into the repo). */
/** Owner-only: the Reddit digest's state (mentions received, last run, which keys are present). */
app.get('/api/admin/reddit', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  c.header('cache-control', 'no-store');
  return c.json(await digestStatus(c.env));
});

/** Owner-only: run the digest now. ?send=0 only returns it; ?threads=N and ?replies=N override the limits; ?hours=N the window. */
app.get('/api/admin/reddit/run', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  c.header('cache-control', 'no-store');
  const num = (k: string) => (c.req.query(k) ? Number(c.req.query(k)) || undefined : undefined);
  const run = await runRedditDigest(c.env, { send: c.req.query('send') !== '0', maxThreads: num('threads'), maxReplies: num('replies'), hours: num('hours') });
  return c.json(run);
});

/** Owner-only: read one Reddit thread the way the digest does (?id=<post id>), to check that Reddit answers the Worker. */
app.get('/api/admin/reddit/fetch', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  const id = (c.req.query('id') ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]{4,12}$/.test(id)) return c.json({ error: 'id must be a Reddit post id' }, 400);
  c.header('cache-control', 'no-store');
  return c.json(await fetchThread(id));
});

/** Owner-only: mark threads as already suggested (?ids=a,b,c) so later digests skip them. */
app.get('/api/admin/reddit/used', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const n = await markUsed(c.env.DB, (c.req.query('ids') ?? '').split(/[,\s]+/), 'marked by owner');
  return c.json({ marked: n });
});

/** Owner-only: parse an F5Bot alert body posted as text (a dry run of the email handler; ?store=1 also stores it). */
app.post('/api/admin/reddit/ingest', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  const parsed = parseF5BotAlert(await c.req.text());
  let stored = 0;
  if (c.req.query('store') === '1') {
    await ensureDatabase(c.env.DB);
    stored = await storeAlert(c.env.DB, null, parsed);
  }
  return c.json({ ...parsed, stored });
});

/**
 * The article pipeline (src/articles.ts). GET /api/admin/articles lists the rows with their preview and review links;
 * /draft?topic=&kind=&slug=&notes= queues a new article (or a revision of an existing slug) for the five-minute cron,
 * &now=1 drafts it in this request instead (several minutes); /run drafts the next queued row now; /suggest?n= asks for
 * topic ideas; /show?slug= returns a row with its article; /review and /act are the owner's review page and its buttons,
 * which accept the row's own token (from the email) as well as the key.
 */
app.get('/api/admin/articles', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const rows = await listArticleRows(c.env.DB, 200);
  const by = (status: string) => rows.filter((r) => r.status === status).length;
  return c.json({
    queued: by('queued'), drafting: by('drafting'), awaiting_review: by('draft'), published: by('published'), failed: by('failed'),
    articles_per_week: c.env.ARTICLES_PER_WEEK ?? '1', effort: c.env.ARTICLE_EFFORT ?? 'high',
    rows: rows.map((r) => articleSummary(c.env, r)),
  });
});

app.get('/api/admin/articles/draft', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const topic = (c.req.query('topic') ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const slug = (c.req.query('slug') ?? '').trim().toLowerCase();
  if (!topic && !slug) return c.json({ error: 'topic (or slug of an existing article) is required' }, 400);
  const req = { topic, kind: asKind(c.req.query('kind'), guessKind(topic || slug)), slug: slug || undefined, notes: (c.req.query('notes') ?? '').trim().slice(0, 2000) };
  try {
    const { row, action } = await enqueueArticle(c.env, req);
    if (c.req.query('now') === '1') {
      await c.env.DB.prepare("UPDATE blog_posts SET status = 'drafting', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?").bind(row.id).run();
      const done = await processRow(c.env, { ...row, status: 'drafting', attempts: row.attempts + 1 });
      return c.json({ action, ...articleSummary(c.env, done) });
    }
    return c.json({ action, ...articleSummary(c.env, row), note: 'The five-minute cron drafts it; an email arrives when the draft is ready.' });
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 400);
  }
});

app.get('/api/admin/articles/run', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const { processed } = await draftNext(c.env);
  return c.json(processed ? articleSummary(c.env, processed) : { processed: null });
});

app.get('/api/admin/articles/suggest', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const n = Math.min(15, Math.max(1, Number(c.req.query('n') ?? '8') || 8));
  return c.json({ topics: await suggestTopics(c.env, n) });
});

app.get('/api/admin/articles/notify', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const row = await getArticleRow(c.env.DB, (c.req.query('slug') ?? '').trim());
  if (!row) return c.json({ error: 'Not found' }, 404);
  try {
    return c.json(await resendDraftEmail(c.env, row));
  } catch (err) {
    return c.json({ sent: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
});

app.get('/api/admin/articles/show', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const row = await getArticleRow(c.env.DB, (c.req.query('slug') ?? '').trim());
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ...articleSummary(c.env, row), draft: parsePost(row.draft_json), live: parsePost(row.post_json) });
});

/** Token or key: the token is the draft's own secret from the email, so the owner key never travels by mail. */
async function articleAccess(c: Context<AppContext>, slug: string, token: string | undefined): Promise<{ row: ArticleRow | null; allowed: boolean }> {
  await ensureDatabase(c.env.DB);
  const row = await getArticleRow(c.env.DB, slug);
  const byKey = !!c.env.STATS_KEY && (c.req.query('key') === c.env.STATS_KEY || token === c.env.STATS_KEY);
  return { row, allowed: byKey || tokenOk(row, token) };
}

app.get('/api/admin/articles/review', async (c) => {
  const slug = (c.req.query('slug') ?? '').trim();
  const { row, allowed } = await articleAccess(c, slug, c.req.query('token'));
  if (!allowed) return c.text('Not found', 404);
  return c.body(reviewPage(c.env, row), 200, { ...htmlHeaders('no-store'), 'x-robots-tag': 'noindex, nofollow' });
});

app.post('/api/admin/articles/act', async (c) => {
  const body = /json/i.test(c.req.header('content-type') ?? '') ? await readJson(c.req.raw) : await readForm(c.req.raw);
  const slug = String(body.slug ?? c.req.query('slug') ?? '').trim();
  const token = String(body.token ?? c.req.query('token') ?? '') || undefined;
  const { row, allowed } = await articleAccess(c, slug, token);
  if (!allowed) return c.text('Not found', 404);
  if (!row) return c.body(reviewPage(c.env, null, { ok: false, text: 'This draft no longer exists.' }), 404, htmlHeaders('no-store'));
  const result = await actOnArticle(c.env, row, String(body.action ?? c.req.query('action') ?? ''), String(body.notes ?? ''), String(body.force ?? c.req.query('force') ?? '') === '1');
  if (/json/i.test(c.req.header('accept') ?? '')) return c.json({ ok: result.ok, message: result.message, row: result.row ? articleSummary(c.env, result.row) : null }, result.ok ? 200 : 400);
  return c.body(reviewPage(c.env, result.row, { ok: result.ok, text: result.message }), result.ok ? 200 : 400, { ...htmlHeaders('no-store'), 'x-robots-tag': 'noindex, nofollow' });
});

/**
 * The Spanish site's content translations (src/translate.ts): the counts, the backlog on demand (&supplements=&posts=,
 * &force=1 translates again, &ref=<slug> one page only) and interface strings for src/i18n/<lang>.json.
 */
app.get('/api/admin/translate/status', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const langs = contentLangs(c.env);
  const [supplements, posts] = await Promise.all([countSupplements(c.env.DB), allPosts(c.env.DB)]);
  const translated: Record<string, Record<string, number>> = {};
  for (const lang of langs) translated[lang] = await translationCounts(c.env.DB, lang);
  return c.json({ langs, supplements, posts: posts.length, translated });
});

app.get('/api/admin/translate', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const lang = asLang(c.req.query('lang') ?? 'es');
  if (!contentLangs(c.env).includes(lang)) return c.json({ error: `${lang} is not in SITE_LANGS` }, 400);
  const n = (key: string, fallback: number, max: number) => Math.min(max, Math.max(0, Number(c.req.query(key) ?? String(fallback)) || 0));
  const ref = (c.req.query('ref') ?? '').trim();
  const [sups, posts] = await Promise.all([listSupplements(c.env.DB, 500, false), allPosts(c.env.DB)]);
  const result = await translateBacklog(
    c.env,
    lang,
    ref ? sups.filter((s) => s.slug === ref) : sups,
    ref ? posts.filter((p) => p.slug === ref) : posts,
    { supplements: n('supplements', 5, 60), posts: n('posts', 1, 20), force: c.req.query('force') === '1' },
  );
  const paths = [...result.supplements.map((slug) => localizePath(`/supplement/${slug}`, lang)), ...result.posts.map((slug) => localizePath(`/blog/${slug}`, lang))];
  if (paths.length) await indexSync(c.env, { paths, curatedOnly: curatedOnly(c.env) }).catch((err) => console.error(`indexing translations failed: ${String(err)}`));
  return c.json(result);
});

app.post('/api/admin/translate/strings', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  const body = await readJson(c.req.raw);
  const lang = asLang(body.lang ?? c.req.query('lang') ?? 'es');
  const strings = Array.isArray(body.strings) ? body.strings.map((v) => String(v)).filter(Boolean).slice(0, 600) : [];
  if (!strings.length) return c.json({ error: 'strings[] is required' }, 400);
  const translated = await translateStrings(c.env, lang, strings);
  return c.json({ lang, translations: Object.fromEntries(strings.map((text, i) => [text, translated[i]])) });
});

/** TikTok (src/tiktok.ts): connect once, then post videos from the pipeline. All routes need the STATS_KEY except the
 *  OAuth callback, which TikTok calls with the state cookie set by /connect. */
app.get('/api/tiktok/connect', (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  if (!tiktokEnabled(c.env)) return c.json({ error: 'TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set' }, 503);
  return startConnect(c, c.env);
});

app.get('/api/tiktok/callback', async (c) => {
  if (!tiktokEnabled(c.env)) return c.json({ error: 'TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set' }, 503);
  await ensureDatabase(c.env.DB);
  const r = await finishConnect(c, c.env);
  c.header('cache-control', 'no-store');
  return c.html(connectPage(r.ok, r.message), r.ok ? 200 : 400);
});

app.get('/api/tiktok/status', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  c.header('cache-control', 'no-store');
  const auth = await getAuth(c.env);
  if (!auth) return c.json({ enabled: tiktokEnabled(c.env), connected: false, posts: [] });
  const ci = c.req.query('creator') === '1' ? await creatorInfo(c.env) : null;
  return c.json({
    enabled: tiktokEnabled(c.env), connected: true,
    account: { open_id: auth.open_id, display_name: auth.display_name, scope: auth.scope, access_expires_at: auth.access_expires_at, refresh_expires_at: auth.refresh_expires_at },
    creator: ci ? (ci.ok ? ci.info : { error: ci.message }) : undefined,
    posts: await listPosts(c.env),
  });
});

app.post('/api/tiktok/disconnect', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await disconnect(c.env);
  return c.json({ ok: true });
});

/** Body: the mp4 itself (content-type video/mp4), or JSON {"video_url": "https://…"} to fetch first. Options come as
 *  query params: title, privacy (PUBLIC_TO_EVERYONE | MUTUAL_FOLLOW_FRIENDS | FOLLOWER_OF_CREATOR | SELF_ONLY), cover_ms. */
app.post('/api/tiktok/post', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  if (!tiktokEnabled(c.env)) return c.json({ error: 'TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set' }, 503);
  await ensureDatabase(c.env.DB);
  const title = (c.req.query('title') ?? '').trim();
  if (!title) return c.json({ error: 'title query parameter is required' }, 400);
  let video: ArrayBuffer;
  if ((c.req.header('content-type') ?? '').includes('application/json')) {
    const body = (await c.req.json().catch(() => ({}))) as { video_url?: string };
    if (!body.video_url) return c.json({ error: 'video_url missing' }, 400);
    const res = await fetch(body.video_url);
    if (!res.ok) return c.json({ error: `fetching video_url failed: HTTP ${res.status}` }, 400);
    video = await res.arrayBuffer();
  } else {
    video = await c.req.arrayBuffer();
  }
  if (video.byteLength > MAX_SINGLE_UPLOAD) return c.json({ error: 'video larger than 64 MB' }, 413);
  const r = await postVideo(c.env, video, {
    title,
    privacy: c.req.query('privacy') || undefined,
    coverMs: c.req.query('cover_ms') ? Number(c.req.query('cover_ms')) : undefined,
    disableComment: c.req.query('comments') === 'off',
    disableDuet: c.req.query('duet') !== 'on',
    disableStitch: c.req.query('stitch') !== 'on',
  });
  if (!r.ok) return c.json({ error: r.message }, 502);
  const videoSlug = (c.req.query('video') ?? '').trim();
  if (videoSlug) await markPosted(c.env, videoSlug, r.publishId);
  return c.json({ ok: true, publish_id: r.publishId, privacy: r.privacy, bytes: video.byteLength });
});

/** Short videos per article (src/videos.ts). The render job (GitHub Actions) uses /next, /ready and /failed. */
app.get('/api/admin/videos', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  c.header('cache-control', 'no-store');
  return c.json({ videos: await listVideos(c.env.DB) });
});

app.post('/api/admin/videos/queue', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const slug = (c.req.query('slug') ?? '').trim();
  if (!slug) return c.json({ error: 'slug is required' }, 400);
  const r = await queueVideo(c.env, slug);
  if (r.ok && c.req.query('now') === '1') await scriptNext(c.env);
  return c.json({ ...r, video: await getVideo(c.env.DB, slug) }, r.ok ? 200 : 400);
});

app.post('/api/admin/videos/script', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  return c.json({ processed: await scriptNext(c.env) });
});

app.get('/api/admin/videos/next', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  c.header('cache-control', 'no-store');
  const job = await nextJob(c.env, c.req.query('slug') || undefined);
  return c.json(job ?? { job: null });
});

app.post('/api/admin/videos/:slug/ready', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as { video_url?: string; duration?: number };
  if (!body.video_url) return c.json({ error: 'video_url is required' }, 400);
  const ok = await markReady(c.env, c.req.param('slug') ?? '', body.video_url, Number(body.duration ?? 0));
  return c.json({ ok }, ok ? 200 : 404);
});

app.post('/api/admin/videos/:slug/failed', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as { error?: string };
  const ok = await markFailed(c.env, c.req.param('slug') ?? '', body.error ?? 'unknown error');
  return c.json({ ok }, ok ? 200 : 404);
});

/** The rendered file, proxied so the posting page can load it without cross-origin trouble. */
app.get('/api/admin/videos/:slug/file', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const row = await getVideo(c.env.DB, c.req.param('slug') ?? '');
  if (!row?.video_url) return c.json({ error: 'no rendered video' }, 404);
  const res = await fetch(row.video_url, { redirect: 'follow' });
  if (!res.ok) return c.json({ error: `fetching the video failed: HTTP ${res.status}` }, 502);
  return new Response(res.body, { headers: { 'content-type': 'video/mp4', 'cache-control': 'private, max-age=600', 'content-disposition': `inline; filename="${row.slug}.mp4"` } });
});

/** Manual state fix for a video row (queued | scripted | ready | posted | failed). */
app.post('/api/admin/videos/:slug/status', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const status = c.req.query('status') ?? '';
  if (!['queued', 'scripted', 'ready', 'posted', 'failed'].includes(status)) return c.json({ error: 'bad status' }, 400);
  await c.env.DB.prepare("UPDATE videos SET status = ?, updated_at = datetime('now') WHERE slug = ?").bind(status, c.req.param('slug') ?? '').run();
  return c.json({ ok: true, video: await getVideo(c.env.DB, c.req.param('slug') ?? '') });
});

/** Zernio (src/zernio.ts): connected accounts, and posting a video through them. */
app.get('/api/admin/zernio/accounts', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  c.header('cache-control', 'no-store');
  if (!zernioEnabled(c.env)) return c.json({ enabled: false, accounts: [] });
  const r = await zernioAccounts(c.env);
  return r.ok ? c.json({ enabled: true, accounts: r.accounts }) : c.json({ enabled: true, error: r.message, accounts: [] }, 502);
});

/** Body: the mp4. Query: title (caption), accounts (comma-separated "platform:accountId"), privacy, comments, duet,
 *  stitch (on/off), ai (off to drop the AI-content label), video (pipeline slug to mark posted). */
app.post('/api/admin/zernio/post', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  if (!zernioEnabled(c.env)) return c.json({ error: 'ZERNIO_API_KEY is not set' }, 503);
  await ensureDatabase(c.env.DB);
  const title = (c.req.query('title') ?? '').trim();
  const targets = (c.req.query('accounts') ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.indexOf(':');
    return { platform: x.slice(0, i), accountId: x.slice(i + 1) };
  }).filter((t) => t.platform && t.accountId);
  if (!title) return c.json({ error: 'title query parameter is required' }, 400);
  if (!targets.length) return c.json({ error: 'accounts query parameter is required (platform:accountId,…)' }, 400);
  const video = await c.req.arrayBuffer();
  if (!video.byteLength) return c.json({ error: 'empty body' }, 400);
  const up = await zernioUpload(c.env, video, `${(c.req.query('video') || 'video').replace(/[^a-z0-9-]/gi, '')}-${Date.now()}.mp4`);
  if (!up.ok) return c.json({ error: up.message }, 502);
  const r = await zernioCreatePost(c.env, {
    content: title,
    mediaUrl: up.url,
    targets,
    privacy: c.req.query('privacy') || undefined,
    allowComment: c.req.query('comments') !== 'off',
    allowDuet: c.req.query('duet') === 'on',
    allowStitch: c.req.query('stitch') === 'on',
    madeWithAi: c.req.query('ai') !== 'off',
  });
  if (!r.ok) return c.json({ error: r.message }, 502);
  const slug = (c.req.query('video') ?? '').trim();
  if (slug) await markPosted(c.env, slug, `zernio:${r.id}`);
  return c.json({ ok: true, post_id: r.id, status: r.status, media_url: up.url, bytes: video.byteLength });
});

app.get('/api/admin/zernio/post/:id', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  c.header('cache-control', 'no-store');
  if (!zernioEnabled(c.env)) return c.json({ error: 'ZERNIO_API_KEY is not set' }, 503);
  const r = await zernioGetPost(c.env, c.req.param('id') ?? '');
  return r.ok ? c.json(r.post) : c.json({ error: r.message }, 502);
});

/** Backlink outreach (src/backlinks.ts): the owner's page, actions, manual runs, the directory checklist and kit. */
async function backlinksPage(c: Context<{ Bindings: Bindings }>, message = ''): Promise<Response> {
  await ensureDatabase(c.env.DB);
  const status = c.req.query('status') || 'drafted';
  const subs = new Map((await c.env.DB.prepare('SELECT name, status, url, note FROM directory_submissions').all<{ name: string; status: string; url: string; note: string }>()).results.map((r) => [r.name, r]));
  const directories = (DIRECTORIES as { name: string; url: string; category: string; note: string }[]).map((d) => ({ ...d, status: subs.get(d.name)?.status ?? 'todo', note: subs.get(d.name)?.note || d.note }));
  c.header('cache-control', 'no-store');
  const rows = await listProspects(c.env, status);
  return c.html(renderBacklinksAdmin({
    counts: await prospectCounts(c.env), status, rows, events: await recentEvents(c.env, rows.map((p) => p.id)),
    perDay: Number(c.env.OUTREACH_PER_DAY ?? '10') || 0, autosend: c.env.OUTREACH_AUTOSEND === 'true', emailReady: emailEnabled(c.env), message, directories,
  }));
}

app.get('/api/admin/backlinks', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  return backlinksPage(c, c.req.query('msg') ?? '');
});

app.get('/api/admin/backlinks/kit', (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  c.header('cache-control', 'no-store');
  return c.html(renderBacklinksKit(new URL(c.req.url).origin));
});

app.get('/api/admin/backlinks/list', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  c.header('cache-control', 'no-store');
  const prospects = await listProspects(c.env, c.req.query('status') || undefined);
  return c.json({ counts: await prospectCounts(c.env), prospects, events: await recentEvents(c.env, prospects.map((p) => p.id)) });
});

app.post('/api/admin/backlinks/act', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const form = await c.req.parseBody();
  const id = Number(form.id);
  const action = String(form.action ?? '');
  const result = await actOnProspect(c.env, id, action, { subject: typeof form.subject === 'string' ? form.subject : undefined, body: typeof form.body === 'string' ? form.body : undefined, email: typeof form.email === 'string' ? form.email : undefined });
  const key = c.req.query('key') ?? '';
  return c.redirect(`/api/admin/backlinks?key=${encodeURIComponent(key)}&status=${encodeURIComponent(c.req.query('status') || 'drafted')}&msg=${encodeURIComponent(`#${id}: ${result}`)}`, 303);
});

app.post('/api/admin/backlinks/add', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const form = await c.req.parseBody();
  const result = await addProspect(c.env, String(form.url ?? ''), String(form.kind ?? 'other') as ProspectKind, String(form.note ?? ''));
  return c.redirect(`/api/admin/backlinks?key=${encodeURIComponent(c.req.query('key') ?? '')}&status=new&msg=${encodeURIComponent(result)}`, 303);
});

app.post('/api/admin/backlinks/directory', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const form = await c.req.parseBody();
  await c.env.DB.prepare("INSERT INTO directory_submissions (name, status, url, note, updated_at) VALUES (?, ?, ?, '', datetime('now')) ON CONFLICT(name) DO UPDATE SET status = excluded.status, url = CASE WHEN excluded.url = '' THEN directory_submissions.url ELSE excluded.url END, updated_at = excluded.updated_at")
    .bind(String(form.name ?? ''), String(form.status ?? 'todo'), String(form.url ?? '')).run();
  return c.redirect(`/api/admin/backlinks?key=${encodeURIComponent(c.req.query('key') ?? '')}&msg=${encodeURIComponent('directory saved')}`, 303);
});

/** ?step=discover|contacts|draft|send|wins|all; JSON when ?format=json, else back to the page. */
app.post('/api/admin/backlinks/run', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  const step = c.req.query('step') ?? 'all';
  let result: unknown;
  try {
    if (step === 'discover') result = await discoverProspects(c.env, c.req.query('theme') ? Number(c.req.query('theme')) : undefined);
    else if (step === 'contacts') result = { contacts: await findContacts(c.env, 12) };
    else if (step === 'draft') result = { drafted: await draftPending(c.env, 10) };
    else if (step === 'send') result = await sendApproved(c.env);
    else if (step === 'wins') result = { won: await checkWins(c.env) };
    else if (step === 'tick') result = { did: await outreachStep(c.env) };
    else result = await dailyOutreach(c.env, { work: true });
  } catch (err) {
    result = { error: String(err).slice(0, 400) };
  }
  if (c.req.query('format') === 'json') return c.json(result);
  return c.redirect(`/api/admin/backlinks?key=${encodeURIComponent(c.req.query('key') ?? '')}&status=${step === 'discover' ? 'new' : 'drafted'}&msg=${encodeURIComponent(`${step}: ${JSON.stringify(result)}`.slice(0, 300))}`, 303);
});

/** The owner's posting page (src/render/tiktok-admin.ts): pick a video, write the caption, choose who can see it, post. */
app.get('/api/admin/tiktok', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  c.header('cache-control', 'no-store');
  const enabled = tiktokEnabled(c.env);
  const auth = enabled ? await getAuth(c.env) : null;
  const ci = auth ? await creatorInfo(c.env) : null;
  const slug = (c.req.query('video') ?? '').trim();
  const video = slug ? await getVideo(c.env.DB, slug) : null;
  const zr = zernioEnabled(c.env) ? await zernioAccounts(c.env) : null;
  return c.html(renderTikTokAdmin({
    zernio: zr ? (zr.ok ? { accounts: zr.accounts, error: '' } : { accounts: [], error: zr.message }) : null,
    enabled, auth,
    creator: ci && ci.ok ? ci.info : null,
    creatorError: ci && !ci.ok ? ci.message : '',
    posts: enabled ? await listPosts(c.env) : [],
    maxBytes: MAX_SINGLE_UPLOAD,
    prefill: video && video.video_url ? { slug: video.slug, caption: video.caption, title: parseScript(video.script_json)?.title ?? video.slug } : null,
  }));
});

app.get('/api/tiktok/post/:publishId', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  c.header('cache-control', 'no-store');
  const r = await postStatus(c.env, c.req.param('publishId') ?? '');
  return r.ok ? c.json(r.status) : c.json({ error: r.message }, 502);
});

/** What the quiz data says (src/quizdata.ts): the aggregate numbers, and &draft=1 queues the data article from them. */
app.get('/api/admin/quizdata', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  await ensureDatabase(c.env.DB);
  if (c.req.query('draft') === '1') return c.json(await queueQuizDataArticle(c.env));
  return c.json(await quizDataSummary(c.env.DB));
});

app.get('/api/admin/export', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  const rows = await exportSupplements(c.env.DB);
  c.header('cache-control', 'no-store');
  c.header('content-disposition', 'attachment; filename="supplements.json"');
  return c.json(
    rows.map(({ id: _id, created_at: _created, source: _source, ...rest }) => rest),
  );
});

app.get('/api/supplements', async (c) => {
  const supplements = await listSupplements(c.env.DB, 500, curatedOnly(c.env));
  c.header('cache-control', 'public, max-age=300');
  return c.json(
    supplements.map((s) => ({
      slug: s.slug, name: s.name, category: s.category, form_type: s.form_type, fda_status: s.fda_status,
      safety_status: s.safety_status, effectivity: s.effectivity, safety: s.safety, summary: s.summary,
      url: `/supplement/${s.slug}`,
    })),
  );
});

// Anything else that reaches the Worker is served from the static assets (with the 404 page as fallback).
app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : langFromPath(c.req.path) !== 'en' ? notFound(c.env, c.req.raw) : c.env.ASSETS.fetch(c.req.raw)));

app.onError((err, c) => {
  console.error(`${c.req.method} ${c.req.path} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'Internal error' }, 500);
  return c.body('Internal error', 500, { 'content-type': 'text/plain; charset=utf-8' });
});

/** One slice of the catalogue through the PubMed check, advancing the cursor the daily and hourly runs share. */
async function researchStep(env: Bindings, batch: number): Promise<Awaited<ReturnType<typeof researchBatch>>> {
  const sups = await listSupplements(env.DB, 500, true);
  const cursor = Number((await getMeta(env.DB, 'research:cursor')) ?? '0') || 0;
  const slice = [...sups.slice(cursor, cursor + batch), ...sups.slice(0, Math.max(0, cursor + batch - sups.length))];
  const result = await researchBatch(env, slice, batch);
  await setMeta(env.DB, 'research:cursor', String((cursor + batch) % Math.max(1, sups.length)));
  return result;
}

export default {
  fetch: app.fetch,
  /**
   * Email Routing handler: hello@aiww.io is routed to this Worker. Every message is forwarded to MAIL_FORWARD_TO (the
   * owner's inbox, exactly as the old routing rule did) and F5Bot's keyword alerts are also parsed into the Reddit
   * digest tables. Forwarding happens first so a parsing problem can never lose mail.
   */
  async email(message: ForwardableEmailMessage, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const forwardTo = (env.MAIL_FORWARD_TO ?? '').trim();
    const from = (message.headers.get('from') ?? '').toLowerCase();
    const isAlert = /alerts@f5bot\.com/.test(from);
    if (!isAlert) {
      // Everything that is not a keyword alert (including F5Bot's own account notices) goes to the inbox untouched.
      // A reply from a backlink prospect is noted on its row first (src/backlinks.ts).
      try {
        const addr = (from.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i) ?? [''])[0];
        if (addr) {
          await ensureDatabase(env.DB);
          const hit = await noteReply(env, addr, message.headers.get('subject') ?? '');
          if (hit) console.log(`backlink reply from ${addr} (${hit.domain})`);
        }
      } catch (err) {
        console.error(`reply check failed: ${String(err)}`);
      }
      if (forwardTo) await message.forward(forwardTo);
      return;
    }
    // Keyword alerts stay with the Worker: parsed and stored, never forwarded (MAIL_FORWARD_ALERTS=true keeps a copy in
    // the inbox). If anything goes wrong the alert is forwarded after all, so it is never lost.
    try {
      await ensureDatabase(env.DB);
      const parsed = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
      const text = parsed.text ?? (parsed.html ?? '').replace(/<[^>]+>/g, '\n');
      const alert = parseF5BotAlert(text);
      const stored = await storeAlert(env.DB, parsed.messageId ?? message.headers.get('message-id'), alert);
      console.log(`f5bot alert: ${stored} mentions stored${alert.limited.length ? `, capped: ${alert.limited.join(', ')}` : ''}`);
      if (forwardTo && env.MAIL_FORWARD_ALERTS === 'true') await message.forward(forwardTo);
    } catch (err) {
      console.error(`f5bot alert failed, forwarding instead: ${String(err)}`);
      if (forwardTo) await message.forward(forwardTo);
    }
    void ctx;
  },
  /** Cron trigger (see wrangler.jsonc): writes a few missing articles per run until the catalogue is complete. */
  async scheduled(event: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 * * * *') {
      // Hourly: build the X queue from the site's own content and send what is due.
      ctx.waitUntil(
        ensureDatabase(env.DB)
          .then(() => pruneAbstractlessNotes(env.DB))
          // Research notes filed without an abstract get a second look here, ten an hour, so the page fills up
          // within hours rather than waiting for the daily research run.
          .then(() => repairNotes(env, 10))
          .then(async (repaired) => {
            if (repaired.filled.length || repaired.failed.length) console.log(`research repaired: ${JSON.stringify(repaired)}`);
            // A few supplements through the PubMed check every hour as well (RESEARCH_HOURLY, default 4, 0 to switch
            // off), so the research page fills in a day instead of a week; the daily run keeps the same cursor.
            const hourly = Math.max(0, Number(env.RESEARCH_HOURLY ?? '4') || 0);
            const research = hourly ? await researchStep(env, hourly) : null;
            if (research && (research.added.length || research.failed.length)) console.log(`research: ${JSON.stringify(research)}`);
            // Score the hour's new Reddit mentions (src/reddit.ts) so the morning digest has little screening left to do.
            if ((env.REDDIT_DIGEST ?? 'true') !== 'false') {
              const screened = await screenStep(env).catch((err) => ({ error: String(err).slice(0, 200) }));
              console.log(`reddit screen: ${JSON.stringify(screened)}`);
            }
            const built = await buildQueue(env);
            if (built.queued.length) console.log(`social queued: ${built.queued.join(', ')}`);
            const result = await postDue(env);
            if (result.posted.length || result.failed.length) console.log(`social: ${JSON.stringify(result)}`);
            await setMeta(env.DB, 'social:last', JSON.stringify({ at: new Date().toISOString(), ...result, repaired, research }));
            // New or changed pages since the last hour go to the IndexNow engines; a changed feed is announced to WebSub.
            const indexed = await indexSync(env, { curatedOnly: curatedOnly(env) });
            if (indexed.paths.length) console.log(`indexing: ${JSON.stringify(indexed)}`);
          })
          .catch((err) => console.error(`social failed: ${String(err)}`)),
      );
      return;
    }
    if (event.cron === '0 7 * * MON') {
      ctx.waitUntil(ensureDatabase(env.DB).then(() => checkWins(env, 40)).then((n) => console.log(`backlink wins: ${n}`)).catch((err) => console.error(`win check failed: ${String(err)}`)));
      // Monday morning: the week's numbers by email to the owner (src/report.ts); skipped quietly without Resend.
      ctx.waitUntil(
        ensureDatabase(env.DB)
          .then(async () => {
            const to = alertRecipient(env);
            if (!to) return;
            const mail = await weeklyReport(env);
            const id = await sendEmail(env, to, mail.subject, mail.html, mail.text);
            await setMeta(env.DB, 'report:last', JSON.stringify({ at: new Date().toISOString(), to, subject: mail.subject, id }));
            console.log(`weekly report sent to ${to}`);
          })
          .catch((err) => console.error(`weekly report failed: ${String(err)}`)),
      );
      return;
    }
    if (event.cron === '52 6 * * *') {
      // Daily: the Reddit reply digest from yesterday's F5Bot alerts (src/reddit.ts); REDDIT_DIGEST=false pauses it.
      if ((env.REDDIT_DIGEST ?? 'true') === 'false') return;
      ctx.waitUntil(
        ensureDatabase(env.DB)
          .then(() => runRedditDigest(env))
          .then((run) => console.log(`reddit digest: ${run.kept.length} replies from ${run.read} threads (${run.mentions_24h} mentions), sent to ${run.sent_to ?? 'nobody'}`))
          .catch((err) => console.error(`reddit digest failed: ${String(err)}`)),
      );
      return;
    }
    if (event.cron === '0 6 * * *') {
      // Daily: look for new PubMed papers about a slice of the catalogue (the whole catalogue in about a week).
      ctx.waitUntil(
        ensureDatabase(env.DB)
          .then(async () => {
            const result = await researchStep(env, Math.max(1, Number(env.RESEARCH_BATCH ?? '15') || 15));
            const repaired = await repairNotes(env, 10);
            await setMeta(env.DB, 'research:last', JSON.stringify({ at: new Date().toISOString(), ...result, repaired }));
            console.log(`research: ${JSON.stringify(result)}`);
          })
          .catch((err) => console.error(`research failed: ${String(err)}`)),
      );
      // Backlink outreach (src/backlinks.ts): discover today's prospects and report the last 24 hours; the contact, draft
      // and send steps run from the five-minute ticks below.
      ctx.waitUntil(
        ensureDatabase(env.DB)
          .then(() => dailyOutreach(env))
          .then(async (r) => { console.log(`outreach: ${JSON.stringify(r)}`); await outreachDigest(env, r); })
          .catch((err) => console.error(`outreach failed: ${String(err)}`)),
      );
      // The article pipeline queues a topic of its own when the week is short of ARTICLES_PER_WEEK and nothing waits.
      ctx.waitUntil(
        ensureDatabase(env.DB)
          .then(() => autoQueue(env))
          .then((r) => console.log(`article auto-queue: ${r.queued ?? 'nothing'} (${r.reason})`))
          .catch((err) => console.error(`article auto-queue failed: ${String(err)}`)),
      );
      return;
    }
    // Every five minutes: one queued article through the writer (src/articles.ts); nothing to do when the queue is empty.
    ctx.waitUntil(
      ensureDatabase(env.DB)
        .then(() => draftNext(env))
        .then(({ processed }) => {
          if (processed) {
            console.log(`article: ${processed.slug} is now ${processed.status}`);
            return;
          }
          // Quiet ticks write the script of a queued video (src/videos.ts), else do one small unit of backlink outreach
          // (src/backlinks.ts), else translate a few pages (src/translate.ts).
          return scriptNext(env).then((did) => (did ? undefined : outreachStep(env))).then((step) => {
            if (typeof step === 'string') { console.log(`outreach: ${step}`); return; }
            if (step === null) return translateStep(env);
          });
        })
        .catch((err) => console.error(`article drafting failed: ${String(err)}`)),
    );
    const batch = Number(env.BACKFILL_BATCH ?? '3');
    if (!batch) return;
    ctx.waitUntil(
      ensureDatabase(env.DB)
        .then(() => mergeDuplicateSupplements(env.DB))
        .then((result) => {
          if (result.merged.length) console.log(`merged duplicate supplements: ${result.merged.join(', ')}`);
        })
        .then(() => backfillContent(env, batch))
        .then(async (content) => {
          console.log(`backfill: ${JSON.stringify(content)}`);
          const faqs = await backfillFaqs(env, batch);
          if (faqs.written.length || faqs.failed.length) console.log(`faqs: ${JSON.stringify(faqs)}`);
          const photos = await backfillProductPhotos(env, 2);
          if (photos.attached.length || photos.failed.length) console.log(`product photos: ${JSON.stringify(photos)}`);
          const images = await backfillImages(env, 2);
          if (images.generated.length || images.failed.length) console.log(`illustrations: ${JSON.stringify(images)}`);
          // Visible on /api/stats as content.last_cron, so progress and failures can be checked without logs.
          await setMeta(env.DB, 'cron:last', JSON.stringify({ at: new Date().toISOString(), batch, articles: content, faqs, photos, illustrations: images }));
        })
        .catch((err) => console.error(`backfill failed: ${String(err)}`)),
    );
  },
};

// ---------- helpers ----------

interface BackfillResult {
  written: string[];
  failed: string[];
  remaining: number;
}

/** The translation backlog for every content language: a few supplements and one article per run (src/translate.ts). */
async function translateStep(env: Bindings, limits = { supplements: 3, posts: 1 }): Promise<void> {
  for (const lang of contentLangs(env)) {
    const [sups, posts] = await Promise.all([listSupplements(env.DB, 500, false), allPosts(env.DB)]);
    const result = await translateBacklog(env, lang, sups, posts, limits);
    if (!result.supplements.length && !result.posts.length && !result.failed.length) continue;
    console.log(`translate ${lang}: ${JSON.stringify(result)}`);
    const paths = [...result.supplements.map((slug) => localizePath(`/supplement/${slug}`, lang)), ...result.posts.map((slug) => localizePath(`/blog/${slug}`, lang))];
    if (paths.length) await indexSync(env, { paths, curatedOnly: curatedOnly(env) }).catch((err) => console.error(`indexing translations failed: ${String(err)}`));
  }
}

/** Give supplements without product photos real iHerb products (AI-created ones first). */
async function backfillProductPhotos(env: Bindings, limit: number): Promise<{ attached: string[]; failed: string[]; remaining: number }> {
  const todo = await supplementsWithoutPhotos(env.DB, limit);
  const attached: string[] = [];
  const failed: string[] = [];
  for (const { slug } of todo) {
    const sup = await getSupplementBySlug(env.DB, slug);
    if (!sup) continue;
    try {
      const n = await attachIherbProducts(env, sup);
      if (n) attached.push(`${slug} (${n})`);
      else failed.push(`${slug}: no match on iHerb`);
    } catch (err) {
      failed.push(`${slug}: ${String(err).slice(0, 160)}`);
      console.error(`product photos for ${slug} failed: ${String(err)}`);
    }
  }
  const remaining = (await supplementsWithoutPhotos(env.DB, 1000)).length;
  return { attached, failed, remaining };
}

async function backfillImages(env: Bindings, limit: number): Promise<{ generated: string[]; failed: string[]; remaining: number }> {
  if (!imageGenerationEnabled(env)) return { generated: [], failed: [], remaining: 0 };
  const todo = await supplementsNeedingImage(env.DB, limit);
  const generated: string[] = [];
  const failed: string[] = [];
  for (const { slug } of todo) {
    const sup = await getSupplementBySlug(env.DB, slug);
    if (!sup) continue;
    try {
      await generateSupplementImage(env, sup);
      generated.push(slug);
    } catch (err) {
      failed.push(`${slug}: ${String(err).slice(0, 160)}`);
      console.error(`illustration for ${slug} failed: ${String(err)}`);
    }
  }
  const remaining = (await supplementsNeedingImage(env.DB, 1000)).length;
  return { generated, failed, remaining };
}

/** Generate articles for up to `limit` supplements that lack one. Safe to run repeatedly. */
async function backfillContent(env: Bindings, limit: number): Promise<BackfillResult> {
  if (!env.OPENAI_API_KEY && env.DEV_FAKE_AI !== 'true') {
    return { written: [], failed: ['OPENAI_API_KEY is not configured'], remaining: await countSupplementsNeedingContent(env.DB, MIN_ARTICLE_LENGTH) };
  }
  const todo = await supplementsNeedingContent(env.DB, MIN_ARTICLE_LENGTH, limit);
  const settled = await Promise.allSettled(
    todo.map(async (sup) => {
      const generated = await generateArticle(env, sup);
      // A supplement that already has a full article only gets the studies list filled in.
      const content = sup.holistic_html.length >= MIN_ARTICLE_LENGTH ? { ...generated, holistic_html: sup.holistic_html } : generated;
      await updateSupplementContent(env.DB, sup.id, content);
      return sup.slug;
    }),
  );
  const written: string[] = [];
  const failed: string[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') written.push(outcome.value);
    else {
      failed.push(`${todo[i].slug}: ${String(outcome.reason).slice(0, 160)}`);
      console.error(`article for ${todo[i].slug} failed: ${String(outcome.reason)}`);
    }
  });
  return { written, failed, remaining: await countSupplementsNeedingContent(env.DB, MIN_ARTICLE_LENGTH) };
}

/** "Common Questions" for up to `limit` supplements that have none yet. */
async function backfillFaqs(env: Bindings, limit: number): Promise<BackfillResult> {
  if (!env.OPENAI_API_KEY && env.DEV_FAKE_AI !== 'true') {
    return { written: [], failed: ['OPENAI_API_KEY is not configured'], remaining: await countSupplementsNeedingFaqs(env.DB) };
  }
  const todo = await supplementsNeedingFaqs(env.DB, limit);
  const settled = await Promise.allSettled(
    todo.map(async (sup) => {
      await updateSupplementFaqs(env.DB, sup.id, await generateFaqs(env, sup));
      return sup.slug;
    }),
  );
  const written: string[] = [];
  const failed: string[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') written.push(outcome.value);
    else {
      failed.push(`${todo[i].slug}: ${String(outcome.reason).slice(0, 160)}`);
      console.error(`faq for ${todo[i].slug} failed: ${String(outcome.reason)}`);
    }
  });
  return { written, failed, remaining: await countSupplementsNeedingFaqs(env.DB) };
}

/** Record a funnel event without delaying the response. Never throws. */
interface TrackContext {
  env: Bindings;
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
  req: { raw: Request; header: (name: string) => string | undefined };
}

function track(c: TrackContext, event: EventInput): void {
  const request = c.req.raw;
  if (isBot(request)) return;
  const ip = c.req.header('cf-connecting-ip') ?? '';
  const referrer = event.referrer ?? externalReferrer(c.req.header('referer'), request.url);
  c.executionCtx.waitUntil(
    hashIp(ip)
      .then((ip_hash) => logEvent(c.env.DB, { ...event, referrer, ip_hash }))
      .catch((err) => console.error(`event not recorded: ${String(err)}`)),
  );
}

/**
 * Crawlers, link-preview fetchers, monitors and scripts are not visitors, so they stay out of the statistics.
 * Cloudflare marks verified bots on every plan; the rest is the usual user-agent vocabulary ("bot" alone covers
 * Googlebot, Bingbot, Twitterbot, LinkedInBot and most others), and an empty user-agent is never a browser. The
 * in-app browsers of X, LinkedIn and Facebook do not match: those are real visitors.
 */
const BOT_UA =
  /bot|crawl|spider|slurp|fetch|scan|monitor|preview|validator|lighthouse|headless|phantom|selenium|playwright|puppeteer|curl|wget|httpie|python|java\/|go-http|okhttp|axios|libwww|perl|ruby|php|node|undici|semrush|ahrefs|mj12|petal|yandex|baiduspider|duckduckbot|gpt|openai|anthropic|claude|perplexity|cohere|bytespider|ccbot|applebot|facebookexternalhit|whatsapp|telegram|discord|slack|skype|embedly|quora|rss|feed|archive|dataprovider|netcraft|censys|shodan|uptime|pingdom|statuscake|site24x7|gtmetrix|pagespeed/i;

function isBot(request: Request): boolean {
  const ua = request.headers.get('user-agent') ?? '';
  if (!ua.trim()) return true;
  const cf = (request as Request & { cf?: { botManagement?: { verifiedBot?: boolean }; verifiedBotCategory?: string } }).cf;
  if (cf?.botManagement?.verifiedBot || cf?.verifiedBotCategory) return true;
  return BOT_UA.test(ua);
}

/** Referrer host when it is another site (own-site navigation is not interesting). */
function externalReferrer(referer: string | undefined, ownUrl: string): string | null {
  if (!referer) return null;
  try {
    const bare = (h: string) => h.replace(/^www\./, '');
    const host = new URL(referer).hostname;
    return host && bare(host) !== bare(new URL(ownUrl).hostname) ? host.slice(0, 120) : null;
  } catch {
    return null;
  }
}

async function notFound(env: Bindings, request: Request): Promise<Response> {
  const res = await fetchAsset(env.ASSETS, request, '/404');
  const page = new Response(res.body, { status: 404, headers: htmlHeaders('no-store') });
  const url = new URL(request.url);
  const lang = langFromPath(url.pathname);
  return lang === 'en' ? page : localizeResponse(page, lang, { origin: url.origin, path: '/404', alternates: false });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function readForm(request: Request): Promise<Record<string, unknown>> {
  try {
    const form = await request.formData();
    const out: Record<string, unknown> = {};
    form.forEach((value, key) => {
      if (typeof value === 'string') out[key] = value;
    });
    return out;
  } catch {
    return {};
  }
}

function validateProfile(body: Record<string, unknown>): { ok: true; profile: QuizProfile } | { ok: false; error: string } {
  const text = (key: string, max: number) => String(body[key] ?? '').trim().slice(0, max);
  const sex = text('Sex', 20) || text('sex', 20);
  const age = text('Age2', 20) || text('age', 20);
  const activity = text('Activity-Level', 40) || text('activity', 40);
  const diet = text('Diet', 256) || text('diet', 256);
  const goal = text('Goal', 256) || text('goal', 256);

  if (!SEXES.includes(sex)) return { ok: false, error: 'Please select your biological sex.' };
  if (!AGES.includes(age)) return { ok: false, error: 'Please select your age group.' };
  if (!ACTIVITIES.includes(activity)) return { ok: false, error: 'Please select your activity level.' };
  if (!diet) return { ok: false, error: 'Please describe your dietary preferences.' };
  if (!goal) return { ok: false, error: 'Please describe your health goals.' };
  return { ok: true, profile: { sex, age, activity, diet, goal } };
}

async function verifyTurnstile(secret: string, token: string, ip: string): Promise<boolean> {
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error(`Turnstile verification failed: ${String(err)}`);
    return false;
  }
}

function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashIp(ip: string): Promise<string | null> {
  if (!ip) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`wellness-whizz:${ip}`));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
