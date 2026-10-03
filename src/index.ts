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
import { Hono } from 'hono';
import { ensureDatabase } from './bootstrap';
import {
  EVENT_TYPES, countRecentSessions, createSession, getSession, getSessionResults, getSupplementBySlug, listSupplements,
  logEvent, markSession, resolveSupplementSlug, statsSummary, type EventInput, type EventType, type QuizProfile,
} from './db';
import { runQuizPipeline } from './pipeline';
import { fetchAsset, renderHome } from './render/home';
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
const CLIENT_EVENT_TYPES: readonly EventType[] = ['quiz_view', 'outbound_click'];

const htmlHeaders = (cacheControl: string) => ({ 'content-type': 'text/html; charset=utf-8', 'cache-control': cacheControl });
const curatedOnly = (env: Bindings) => env.LIST_AI_SUPPLEMENTS === 'false';
/** DEV_FAKE_AI (canned answers instead of OpenAI) is honoured on localhost only, never on a deployed site. */
const isLocalRequest = (url: string) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname);
/** Turnstile is on only when both the public site key and the secret are configured. */
const turnstileSiteKey = (env: Bindings) => (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : null);

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
  return c.body(renderResultPage(session, items, c.env), 200, htmlHeaders('private, max-age=0, must-revalidate'));
});

app.get('/supplement/:slug', async (c) => {
  const slug = c.req.param('slug');
  const supplement = await getSupplementBySlug(c.env.DB, slug);
  if (!supplement) {
    // Temporary redirect: the catalogue grows, so the mapping of a short slug may change.
    const canonical = await resolveSupplementSlug(c.env.DB, slug);
    return canonical ? c.redirect(`/supplement/${canonical}`, 302) : notFound(c.env, c.req.raw);
  }
  const explore = await listSupplements(c.env.DB, 200, curatedOnly(c.env));
  track(c, { type: 'supplement_view', page: `/supplement/${supplement.slug}`, slug: supplement.slug });
  return c.body(renderSupplementPage(supplement, explore, c.env), 200, htmlHeaders('public, max-age=300'));
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
  const work = runQuizPipeline(env, id, validation.profile).then(
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

app.get('/api/stats', async (c) => {
  const key = c.env.STATS_KEY;
  if (!key) return c.json({ error: 'Not found' }, 404);
  const provided = c.req.query('key') ?? (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!provided || provided !== key) return c.json({ error: 'Unauthorized' }, 401);
  c.header('cache-control', 'no-store');
  return c.json(await statsSummary(c.env.DB));
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

export default app;

// ---------- helpers ----------

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
