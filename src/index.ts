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
 *   /result/:id            personalised results page
 *   /supplement/:slug      supplement detail page
 */
import { Hono, type Context } from 'hono';
import { POSTS, getPost, supplementSlugsUsed } from './blog';
import { ensureDatabase } from './bootstrap';
import { MIN_ARTICLE_LENGTH, generateArticle } from './content';
import { generateSupplementImage, imageGenerationEnabled, loadImage, storeImage, supplementsNeedingImage } from './images';
import { attachIherbProducts, supplementsWithoutPhotos } from './products';
import { emailEnabled, resultsEmail, sendEmail } from './email';
import { listResearchNotes, researchBatch } from './research';
import { renderResearchPage } from './render/research';
import { renderSupplementsIndex } from './render/supplements-index';
import { buildQueue, listSocialPosts, postDue, setSocialStatus } from './social/content';
import {
  EVENT_TYPES, countRecentSessions, countSupplementsNeedingContent, createSession, exportSupplements, getSession,
  getSessionResults, getSupplementBySlug, listSupplements, logEvent, markSession, mergeDuplicateSupplements,
  resolveSupplementSlug, statsSummary, supplementsNeedingContent, updateSupplementContent, type EventInput,
  type EventType, type QuizProfile, countSupplements, getSupplementsBySlugs, listSupplementSlugs,
  addSubscriber, contentProgress, countRecentSubscriptions, getMeta, listSubscribers, markSubscriberSent, relatedSupplements, setMeta,
} from './db';
import { runQuizPipeline } from './pipeline';
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
  DEV_FAKE_AI?: string;
  PRODUCT_SEARCH_URL?: string;
  IHERB_RCODE?: string;
  RATE_LIMIT_PER_HOUR?: string;
  GLOBAL_LIMIT_PER_HOUR?: string;
  LIST_AI_SUPPLEMENTS?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  STATS_KEY?: string;
  /** Supplements per cron run of the article writer; "0" disables the scheduled backfill. */
  BACKFILL_BATCH?: string;
  /** "false" turns off generated illustrations for supplements without product photos. */
  IMAGE_GENERATION?: string;
  /** X (Twitter) posting: the four keys of a developer app with read and write permission (src/social/x.ts). */
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;
  /** "false" keeps posts queued without sending them; X_POSTS_PER_DAY caps sends (default 2). */
  X_AUTOPOST?: string;
  X_POSTS_PER_DAY?: string;
  /** Optional NCBI key for faster PubMed requests; RESEARCH_BATCH supplements checked per daily run (default 15). */
  NCBI_API_KEY?: string;
  RESEARCH_BATCH?: string;
  /** Optional: the site's one public hostname (e.g. aiww.io); other hostnames redirect to it. */
  CANONICAL_HOST?: string;
  /** Optional: Resend API key + verified sender for "Email me my results" (src/email.ts). */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  IMAGE_MODEL?: string;
}

type AppContext = { Bindings: Bindings };
const app = new Hono<AppContext>();

const AGES = ['<18', '18-25', '26-40', '41-65', '65+'];
const ACTIVITIES = ['Sedentary', 'Lightly Active', 'Moderately Active', 'Very Active', 'Extra Active'];
const SEXES = ['Female', 'Male'];
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** A session still pending after this long has lost its Worker (client disconnected); it is marked failed. */
const PENDING_TIMEOUT_MS = 4 * 60 * 1000;
/** Event types the browser may report; page views are recorded server-side. */
const CLIENT_EVENT_TYPES: readonly EventType[] = ['quiz_view', 'outbound_click', 'subscribe', 'share'];

const htmlHeaders = (cacheControl: string) => ({ 'content-type': 'text/html; charset=utf-8', 'cache-control': cacheControl });
const curatedOnly = (env: Bindings) => env.LIST_AI_SUPPLEMENTS === 'false';
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

// ---------- pages ----------

app.get('/', (c) => {
  track(c, { type: 'home_view', page: '/' });
  return renderHome(c.env, c.req.raw, curatedOnly(c.env));
});

app.get('/result/:id', async (c) => {
  const id = c.req.param('id');
  if (!SESSION_ID_RE.test(id)) return notFound(c.env, c.req.raw);
  const session = await getSession(c.env.DB, id);
  if (!session) return notFound(c.env, c.req.raw);

  if (session.status === 'pending') {
    const startedAt = Date.parse(session.created_at + 'Z');
    if (Number.isFinite(startedAt) && Date.now() - startedAt > PENDING_TIMEOUT_MS) {
      await markSession(c.env.DB, id, 'failed', 'Timed out while preparing the recommendation');
      return c.body(renderFailedPage(session), 200, htmlHeaders('no-store'));
    }
    return c.body(renderPendingPage(session), 200, htmlHeaders('no-store'));
  }
  if (session.status === 'failed') return c.body(renderFailedPage(session), 200, htmlHeaders('no-store'));

  const items = await getSessionResults(c.env.DB, id);
  if (!items.length) return c.body(renderFailedPage(session), 200, htmlHeaders('no-store'));
  track(c, { type: 'result_view', page: `/result/${id}`, session_id: id });
  return c.body(renderResultPage(session, items, c.env, { origin: new URL(c.req.url).origin }), 200, htmlHeaders('private, max-age=0, must-revalidate'));
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

app.get('/supplement/:slug', async (c) => {
  const slug = c.req.param('slug');
  const supplement = await getSupplementBySlug(c.env.DB, slug);
  if (!supplement) {
    // Temporary redirect: the catalogue grows, so the mapping of a short slug may change.
    const canonical = await resolveSupplementSlug(c.env.DB, slug);
    return canonical ? c.redirect(`/supplement/${canonical}`, 302) : notFound(c.env, c.req.raw);
  }
  const [explore, related] = await Promise.all([
    listSupplements(c.env.DB, 200, curatedOnly(c.env)),
    relatedSupplements(c.env.DB, supplement, 4, curatedOnly(c.env)),
  ]);
  track(c, { type: 'supplement_view', page: `/supplement/${supplement.slug}`, slug: supplement.slug });
  return c.body(
    renderSupplementPage(supplement, explore, c.env, { related, origin: new URL(c.req.url).origin }),
    200,
    htmlHeaders('public, max-age=300'),
  );
});

// ---------- editorial pages ----------

app.get('/how-it-works', async (c) => {
  const n = await countSupplements(c.env.DB);
  track(c, { type: 'page_view', page: '/how-it-works' });
  return c.body(renderHowItWorks(n), 200, htmlHeaders('public, max-age=600'));
});

app.get('/terms', (c) => {
  track(c, { type: 'page_view', page: '/terms' });
  return c.body(renderTerms(), 200, htmlHeaders('public, max-age=600'));
});

app.get('/blog', async (c) => {
  const supplements = await getSupplementsBySlugs(c.env.DB, POSTS.map((p) => p.heroSupplement));
  track(c, { type: 'page_view', page: '/blog' });
  const ctx = { env: c.env, origin: new URL(c.req.url).origin, supplements };
  return c.body(renderBlogIndex(ctx, POSTS), 200, htmlHeaders('public, max-age=600'));
});

app.get('/blog/:slug', async (c) => {
  const post = getPost(c.req.param('slug'));
  if (!post) return notFound(c.env, c.req.raw);
  const related = POSTS.filter((p) => p.slug !== post.slug).slice(0, 3);
  const supplements = await getSupplementsBySlugs(c.env.DB, [...supplementSlugsUsed(post), ...related.map((p) => p.heroSupplement)]);
  track(c, { type: 'page_view', page: `/blog/${post.slug}`, slug: `blog:${post.slug}` });
  const ctx = { env: c.env, origin: new URL(c.req.url).origin, supplements };
  return c.body(renderBlogPost(ctx, post, related), 200, htmlHeaders('public, max-age=600'));
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
    ...POSTS.map((p) => line(p.title, `/blog/${p.slug}`, p.description)),
    '',
    '## Supplement guides',
    ...supplements.map((s) => line(s.name, `/supplement/${s.slug}`, s.summary)),
    '',
  ].join('\n');
  return c.body(body, 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
});

app.get('/supplements', async (c) => {
  const supplements = await listSupplements(c.env.DB, 500, curatedOnly(c.env));
  track(c, { type: 'page_view', page: '/supplements' });
  return c.body(renderSupplementsIndex(supplements, new URL(c.req.url).origin), 200, htmlHeaders('public, max-age=600'));
});

app.get('/research', async (c) => {
  const notes = await listResearchNotes(c.env.DB, 100);
  track(c, { type: 'page_view', page: '/research' });
  return c.body(renderResearchPage(notes, new URL(c.req.url).origin), 200, htmlHeaders('public, max-age=600'));
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
    const built = await buildQueue(c.env);
    return c.json({ built, posts: await listSocialPosts(c.env.DB) });
  }
  if (action === 'post') return c.json({ result: await postDue(c.env), posts: await listSocialPosts(c.env.DB) });
  if (action === 'research') {
    const sups = await listSupplements(c.env.DB, 500, true);
    return c.json({ result: await researchBatch(c.env, sups.sort(() => Math.random() - 0.5), 5), notes: (await listResearchNotes(c.env.DB, 10)).length });
  }
  return c.json({ posts: await listSocialPosts(c.env.DB) });
});

app.get('/sitemap.xml', async (c) => {
  const origin = new URL(c.req.url).origin;
  const supplements = await listSupplementSlugs(c.env.DB, curatedOnly(c.env));
  const urls: { loc: string; lastmod?: string; priority: string }[] = [
    { loc: '/', priority: '1.0' },
    { loc: '/wellness-quiz', priority: '0.9' },
    { loc: '/blog', priority: '0.8' },
    { loc: '/supplements', priority: '0.8' },
    { loc: '/research', priority: '0.7' },
    { loc: '/how-it-works', priority: '0.6' },
    { loc: '/terms', priority: '0.2' },
    ...POSTS.map((p) => ({ loc: `/blog/${p.slug}`, lastmod: p.date, priority: '0.8' })),
    ...supplements.map((s) => ({ loc: `/supplement/${s.slug}`, lastmod: s.created_at.slice(0, 10), priority: '0.7' })),
  ];
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(
        (u) =>
          `  <url><loc>${origin}${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.priority}</priority></url>`,
      )
      .join('\n') +
    '\n</urlset>\n';
  return c.body(xml, 200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' });
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

  if (!(await createSession(c.env.DB, id, validation.profile, ipHash))) return existingResponse(); // lost a race

  // The browser stays connected while the pipeline runs; waitUntil covers a short disconnect at the end.
  const work = runQuizPipeline(env, id, validation.profile, (job) => c.executionCtx.waitUntil(job)).then(
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
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) return c.json({ error: 'Please enter a valid email address.' }, 400);
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
  const [stats, content, lastCron, lastSocial, lastResearch] = await Promise.all([
    statsSummary(c.env.DB),
    contentProgress(c.env.DB, MIN_ARTICLE_LENGTH),
    getMeta(c.env.DB, 'cron:last'),
    getMeta(c.env.DB, 'social:last'),
    getMeta(c.env.DB, 'research:last'),
  ]);
  const parse = (v: string | null): unknown => {
    try {
      return v ? JSON.parse(v) : null;
    } catch {
      return v;
    }
  };
  return c.json({ ...stats, content: { ...content, last_cron: parse(lastCron) }, social: { last_run: parse(lastSocial) }, research: { last_run: parse(lastResearch) } });
});

/** Write missing articles now (the cron does the same a few at a time). ?limit=N, default 3. */
app.get('/api/admin/backfill', async (c) => {
  const denied = authorized(c);
  if (denied) return denied;
  const limit = Math.min(10, Math.max(1, Number(c.req.query('limit') ?? '3') || 3));
  c.header('cache-control', 'no-store');
  const merged = await mergeDuplicateSupplements(c.env.DB);
  const content = await backfillContent(c.env, limit);
  const photos = await backfillProductPhotos(c.env, Math.min(limit, 3));
  const images = await backfillImages(c.env, Math.min(limit, 3));
  return c.json({ ...content, merged: merged.merged, photos, illustrations: images });
});

/** The whole catalogue as JSON, in the shape of data/supplements.json (to bundle AI-written content into the repo). */
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
app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.env.ASSETS.fetch(c.req.raw)));

app.onError((err, c) => {
  console.error(`${c.req.method} ${c.req.path} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'Internal error' }, 500);
  return c.body('Internal error', 500, { 'content-type': 'text/plain; charset=utf-8' });
});

export default {
  fetch: app.fetch,
  /** Cron trigger (see wrangler.jsonc): writes a few missing articles per run until the catalogue is complete. */
  async scheduled(event: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 * * * *') {
      // Hourly: build the X queue from the site's own content and send what is due.
      ctx.waitUntil(
        ensureDatabase(env.DB)
          .then(() => buildQueue(env))
          .then((built) => {
            if (built.queued.length) console.log(`social queued: ${built.queued.join(', ')}`);
            return postDue(env);
          })
          .then((result) => {
            if (result.posted.length || result.failed.length) console.log(`social: ${JSON.stringify(result)}`);
            return setMeta(env.DB, 'social:last', JSON.stringify({ at: new Date().toISOString(), ...result }));
          })
          .catch((err) => console.error(`social failed: ${String(err)}`)),
      );
      return;
    }
    if (event.cron === '0 6 * * *') {
      // Daily: look for new PubMed papers about a slice of the catalogue (the whole catalogue in about a week).
      ctx.waitUntil(
        ensureDatabase(env.DB)
          .then(async () => {
            const sups = await listSupplements(env.DB, 500, true);
            const batch = Math.max(1, Number(env.RESEARCH_BATCH ?? '15') || 15);
            const cursor = Number((await getMeta(env.DB, 'research:cursor')) ?? '0') || 0;
            const slice = [...sups.slice(cursor, cursor + batch), ...sups.slice(0, Math.max(0, cursor + batch - sups.length))];
            const result = await researchBatch(env, slice, batch);
            await setMeta(env.DB, 'research:cursor', String((cursor + batch) % Math.max(1, sups.length)));
            await setMeta(env.DB, 'research:last', JSON.stringify({ at: new Date().toISOString(), ...result }));
            console.log(`research: ${JSON.stringify(result)}`);
          })
          .catch((err) => console.error(`research failed: ${String(err)}`)),
      );
      return;
    }
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
          const photos = await backfillProductPhotos(env, 2);
          if (photos.attached.length || photos.failed.length) console.log(`product photos: ${JSON.stringify(photos)}`);
          const images = await backfillImages(env, 2);
          if (images.generated.length || images.failed.length) console.log(`illustrations: ${JSON.stringify(images)}`);
          // Visible on /api/stats as content.last_cron, so progress and failures can be checked without logs.
          await setMeta(env.DB, 'cron:last', JSON.stringify({ at: new Date().toISOString(), batch, articles: content, photos, illustrations: images }));
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

/** Illustrations for up to `limit` supplements (AI-created first) that have no product photos. */
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

/** Record a funnel event without delaying the response. Never throws. */
interface TrackContext {
  env: Bindings;
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
  req: { raw: Request; header: (name: string) => string | undefined };
}

function track(c: TrackContext, event: EventInput): void {
  const request = c.req.raw;
  const ip = c.req.header('cf-connecting-ip') ?? '';
  const referrer = event.referrer ?? externalReferrer(c.req.header('referer'), request.url);
  c.executionCtx.waitUntil(
    hashIp(ip)
      .then((ip_hash) => logEvent(c.env.DB, { ...event, referrer, ip_hash }))
      .catch((err) => console.error(`event not recorded: ${String(err)}`)),
  );
}

/** Referrer host when it is another site (own-site navigation is not interesting). */
function externalReferrer(referer: string | undefined, ownUrl: string): string | null {
  if (!referer) return null;
  try {
    const host = new URL(referer).hostname;
    return host && host !== new URL(ownUrl).hostname ? host.slice(0, 120) : null;
  } catch {
    return null;
  }
}

async function notFound(env: Bindings, request: Request): Promise<Response> {
  const res = await fetchAsset(env.ASSETS, request, '/404');
  return new Response(res.body, { status: 404, headers: htmlHeaders('no-store') });
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
