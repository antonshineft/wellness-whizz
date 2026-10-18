/**
 * Backlink outreach, run from the Worker with API credits.
 *
 * Daily (cron): discover prospects with Claude's web search (resource pages, blogs that take guest posts, "best tools"
 * lists, health newsletters), find a contact address on each site, write a short personalised pitch with Claude,
 * and send approved pitches from hello@aiww.io through Resend (OUTREACH_PER_DAY a day, OUTREACH_AUTOSEND=true skips
 * the approval step). Replies to hello@aiww.io come back through the Worker's email handler and mark the prospect
 * "replied"; one follow-up goes out after six quiet days; a weekly check looks for the link on the prospect's page
 * and marks it "won". The owner's page: /api/admin/backlinks?key=…
 */
import Anthropic from '@anthropic-ai/sdk';
import { claudeJson, claudeModel, type ClaudeEnv } from './claude';
import { alertRecipient, emailEnabled, sendEmail, type EmailEnv } from './email';

export interface BacklinkEnv extends ClaudeEnv, EmailEnv {
  DB: D1Database;
  DIGEST_TO?: string;
  STATS_KEY?: string;
  CANONICAL_HOST?: string;
  DEV_FAKE_AI?: string;
  /** Pitches sent per day (default 10); "0" pauses sending. */
  OUTREACH_PER_DAY?: string;
  /** "true" sends drafts without waiting for approval on the admin page. */
  OUTREACH_AUTOSEND?: string;
  /** Who signs the emails (default "Anton"). */
  OUTREACH_SIGNATURE?: string;
}

export type ProspectKind = 'resource-page' | 'guest-post' | 'blog' | 'tool-list' | 'newsletter' | 'journalist' | 'directory' | 'other';
export type ProspectStatus = 'new' | 'no-contact' | 'drafted' | 'sent' | 'followed-up' | 'replied' | 'won' | 'declined' | 'skipped';

export interface Prospect {
  id: number;
  domain: string;
  url: string;
  kind: ProspectKind;
  title: string;
  why: string;
  language: string;
  score: number;
  contact_email: string;
  contact_name: string;
  contact_url: string;
  asset: string;
  status: ProspectStatus;
  approved: number;
  draft_subject: string;
  draft_body: string;
  sent_at: string | null;
  followup_at: string | null;
  replied_at: string | null;
  won_url: string;
  notes: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export const PROSPECT_SQL = [
  `CREATE TABLE IF NOT EXISTS link_prospects (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL UNIQUE, url TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'other', title TEXT NOT NULL DEFAULT '', why TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT 'en', score INTEGER NOT NULL DEFAULT 0, contact_email TEXT NOT NULL DEFAULT '', contact_name TEXT NOT NULL DEFAULT '', contact_url TEXT NOT NULL DEFAULT '', asset TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new', approved INTEGER NOT NULL DEFAULT 0, draft_subject TEXT NOT NULL DEFAULT '', draft_body TEXT NOT NULL DEFAULT '', sent_at TEXT, followup_at TEXT, replied_at TEXT, won_url TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS link_prospects_status ON link_prospects(status)`,
  `CREATE TABLE IF NOT EXISTS link_events (id INTEGER PRIMARY KEY AUTOINCREMENT, prospect_id INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS directory_submissions (name TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'todo', url TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
];

function origin(env: BacklinkEnv): string {
  const host = (env.CANONICAL_HOST ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return host ? `https://${host}` : 'https://aiww.io';
}

const SITE_BRIEF = `Wellness Whizz (aiww.io) is a free, independent AI supplement guide: a two-minute quiz that turns someone's goals, diet and lifestyle into a short list of supplements with plain-English reasons; 150 evidence-based supplement pages with dosing, safety and study links; dosage guides; a protein calculator; a "scan your supplement shelf" photo tool; a quiz-data report on what people actually take; and a full Spanish version at aiww.io/es/. It is funded by affiliate links (disclosed), has no accounts or paywall, and never sells data.`;

/** Linkable pages we can offer, picked per prospect by the model. */
export const ASSETS: { path: string; label: string; pitch: string }[] = [
  { path: '/blog/what-people-actually-take-quiz-data', label: 'Quiz data report', pitch: 'original data from 200+ quiz sessions on what people actually take and why' },
  { path: '/blog/protein-intake-calculator', label: 'Protein calculator', pitch: 'a free protein intake calculator with the evidence behind the numbers' },
  { path: '/shelf', label: 'Shelf scanner', pitch: 'a free tool that reads a photo of someone\'s supplement shelf and flags overlaps and gaps' },
  { path: '/', label: 'AI supplement quiz', pitch: 'a free two-minute AI quiz that gives personalised supplement suggestions with reasons' },
  { path: '/supplements', label: 'Supplement library', pitch: '150 evidence-based supplement pages with dosing, safety and study links' },
  { path: '/blog', label: 'Dosage guides', pitch: 'plain-English dosage guides with the studies behind each number' },
  { path: '/es/', label: 'Spanish site', pitch: 'the whole guide in Spanish, free' },
];

const BLOCKED = /(^|\.)(amazon|reddit|wikipedia|youtube|facebook|instagram|tiktok|twitter|x|linkedin|pinterest|quora|medium|substack|google|apple|microsoft|iherb|walmart|ebay|etsy|webmd|healthline|mayoclinic|nih|gov|edu|examine)\.(com|org|net|co|io|gov|edu|es)$/i;

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Discovery with Claude's web search

const THEMES: { kind: ProspectKind; language: string; brief: string }[] = [
  { kind: 'resource-page', language: 'en', brief: 'resource pages or "useful links" pages on nutrition, fitness, wellness or supplement websites that list external tools and guides (search for things like "supplement resources", "nutrition resources page", "useful links supplements", "recommended tools nutrition")' },
  { kind: 'guest-post', language: 'en', brief: 'health, fitness, nutrition or supplement blogs that accept guest posts or contributor articles ("write for us" supplements, "guest post" nutrition, "contribute" wellness blog)' },
  { kind: 'tool-list', language: 'en', brief: 'articles or directories listing AI health tools, AI wellness apps or "best supplement apps" where a free AI supplement quiz would belong' },
  { kind: 'blog', language: 'en', brief: 'independent blogs and small publications that recently wrote about creatine, magnesium, protein intake, ashwagandha or supplement stacks and link out to sources and tools' },
  { kind: 'newsletter', language: 'en', brief: 'email newsletters and curated weekly roundups about fitness, longevity, biohacking or nutrition that feature free tools and data' },
  { kind: 'journalist', language: 'en', brief: 'journalists and writers who cover supplements, nutrition data or consumer health and have published in the last year (we can offer original quiz data)' },
  { kind: 'resource-page', language: 'es', brief: 'páginas de recursos o enlaces útiles en webs de nutrición, fitness o suplementos en español (España y Latinoamérica)' },
  { kind: 'guest-post', language: 'es', brief: 'blogs de salud, fitness o nutrición en español que aceptan artículos de colaboradores ("escribe para nosotros", "colabora", "artículo invitado")' },
  { kind: 'tool-list', language: 'en', brief: 'lists of free health calculators and quizzes (BMI, protein, calorie calculators) on fitness and nutrition sites that could add a supplement quiz and protein calculator' },
  { kind: 'blog', language: 'en', brief: 'personal trainers, dietitians and coaches with their own websites who write about supplements for clients and keep a links or recommendations page' },
];

export interface Found { url: string; title: string; why: string; kind?: string; contact_hint?: string; score?: number }

export async function discoverProspects(env: BacklinkEnv, themeIndex?: number): Promise<{ theme: string; found: number; added: number }> {
  const theme = THEMES[(themeIndex ?? dayIndex()) % THEMES.length];
  let found: Found[] = [];
  if (env.DEV_FAKE_AI === 'true') {
    found = [{ url: 'https://example-fitness-blog.test/resources', title: 'Fitness resources', why: 'lists nutrition tools', score: 60 }];
  } else {
    found = await searchProspects(env, theme);
  }
  let added = 0;
  for (const f of found) {
    const domain = domainOf(f.url);
    if (!domain || BLOCKED.test(domain) || domain.endsWith('aiww.io')) continue;
    const exists = await env.DB.prepare('SELECT id FROM link_prospects WHERE domain = ?').bind(domain).first();
    if (exists) continue;
    const kind = (['resource-page', 'guest-post', 'blog', 'tool-list', 'newsletter', 'journalist', 'directory'].includes(f.kind ?? '') ? f.kind : theme.kind) as ProspectKind;
    await env.DB.prepare(
      `INSERT INTO link_prospects (domain, url, kind, title, why, language, score, contact_email, notes, source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', datetime('now'), datetime('now'))`,
    ).bind(domain, f.url.slice(0, 500), kind, (f.title ?? '').slice(0, 200), (f.why ?? '').slice(0, 500), theme.language, Math.max(0, Math.min(100, Math.round(f.score ?? 50))),
      '', f.contact_hint ? `contact hint: ${f.contact_hint}`.slice(0, 300) : '', `search:${theme.kind}:${theme.language}`).run();
    added++;
  }
  return { theme: `${theme.kind} (${theme.language})`, found: found.length, added };
}

function dayIndex(): number {
  return Math.floor(Date.now() / 86_400_000);
}

async function searchProspects(env: BacklinkEnv, theme: { kind: ProspectKind; language: string; brief: string }): Promise<Found[]> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 170_000, maxRetries: 1 });
  const prompt = `${SITE_BRIEF}

Find 12 to 15 real, currently reachable web pages of this kind: ${theme.brief}.
Language of the sites: ${theme.language === 'es' ? 'Spanish' : 'English'}.
Prefer independent sites with real editors (not big publishers, not marketplaces, not forums, not social networks). Skip anything that sells supplements directly as its main business. Each result must be a page where a link to Wellness Whizz would plausibly fit, with a one-line reason.

Answer with only a JSON array, no prose, like:
[{"url":"https://…","title":"…","why":"…","kind":"${theme.kind}","contact_hint":"editor name or contact page if you saw one, else empty","score":0-100 fit and reputation}]`;
  const res = await client.messages.create({
    model: claudeModel(env, 'fast'),
    max_tokens: 4000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 } as unknown as Anthropic.ToolUnion],
    messages: [{ role: 'user', content: prompt }],
  });
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n');
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`search gave no JSON: ${text.slice(0, 200)}`);
  const arr = JSON.parse(m[0]) as Found[];
  return arr.filter((f) => f && typeof f.url === 'string' && /^https?:\/\//.test(f.url));
}

// ---------------------------------------------------------------------------------------------------------------------
// Contacts

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const BAD_EMAIL = /(noreply|no-reply|donotreply|example\.|sentry|wixpress|\.png$|\.jpg$|\.gif$|\.svg$|\.webp$|@(w3|schema|googleapis|gravatar|apple|google|email|domain|yourdomain|company|site|yoursite|website|mysite|test)\.|^(you|your|yourname|name|email|user|username|someone|test|john|jane|johndoe|firstname|first\.last|example)@)/i;

async function fetchText(url: string, max = 300_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; WellnessWhizzBot/1.0; +https://aiww.io)', accept: 'text/html,*/*' }, redirect: 'follow' });
    if (!res.ok) return '';
    const text = await res.text();
    return text.slice(0, max);
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

function emailsIn(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.replace(/\s*\[at\]\s*/gi, '@').replace(/\s*\(at\)\s*/gi, '@').match(EMAIL_RE) ?? []) {
    const e = m.toLowerCase();
    if (!BAD_EMAIL.test(e) && e.length < 80) out.add(e);
  }
  return [...out];
}

function pickEmail(emails: string[], domain: string): string {
  const own = emails.filter((e) => e.endsWith(`@${domain}`) || e.endsWith(`.${domain}`));
  const pool = own.length ? own : emails;
  const pref = ['editor', 'hello', 'hi', 'contact', 'info', 'press', 'media', 'team', 'admin', 'support'];
  pool.sort((a, b) => (pref.findIndex((p) => a.startsWith(p)) + 1 || 99) - (pref.findIndex((p) => b.startsWith(p)) + 1 || 99));
  return pool[0] ?? '';
}

/** Look for an email address on the prospect's page, home page and the usual contact pages. */
export async function findContact(env: BacklinkEnv, p: Prospect): Promise<{ email: string; contactUrl: string }> {
  const base = `https://${p.domain}`;
  const pages = [p.url, base];
  const first = await fetchText(p.url);
  const links = [...first.matchAll(/href="([^"#]+)"/gi)].map((m) => m[1]).filter((h) => /contact|about|write-for-us|contribute|contacto|colabora|sobre/i.test(h)).slice(0, 4);
  for (const h of links) {
    try { pages.push(new URL(h, p.url).toString()); } catch { /* ignore */ }
  }
  pages.push(`${base}/contact`, `${base}/about`, `${base}/contact-us`, `${base}/write-for-us`);
  const seen = new Set<string>();
  let contactUrl = '';
  for (const u of pages) {
    if (seen.has(u) || seen.size > 7) continue;
    seen.add(u);
    const html = u === p.url ? first : await fetchText(u);
    if (!html) continue;
    if (!contactUrl && /contact|contacto/i.test(u) && /<form/i.test(html)) contactUrl = u;
    const email = pickEmail(emailsIn(html), p.domain);
    if (email) return { email, contactUrl: contactUrl || (u !== p.url ? u : '') };
  }
  return { email: '', contactUrl };
}

export async function findContacts(env: BacklinkEnv, limit = 8): Promise<number> {
  const rows = (await env.DB.prepare("SELECT * FROM link_prospects WHERE status = 'new' AND contact_email = '' ORDER BY score DESC, id LIMIT ?").bind(limit).all<Prospect>()).results;
  let found = 0;
  for (const p of rows) {
    let c: { email: string; contactUrl: string };
    try {
      c = env.DEV_FAKE_AI === 'true' ? { email: `editor@${p.domain}`, contactUrl: '' } : await findContact(env, p);
    } catch (err) {
      // A lookup that throws (network, model) must not block the queue: the row is parked as no-contact with the reason.
      await env.DB.prepare("UPDATE link_prospects SET status = 'no-contact', updated_at = datetime('now') WHERE id = ?").bind(p.id).run();
      await logEvent(env, p.id, 'contact-failed', String(err).slice(0, 300));
      continue;
    }
    if (c.email) {
      found++;
      await env.DB.prepare("UPDATE link_prospects SET contact_email = ?, contact_url = ?, updated_at = datetime('now') WHERE id = ?").bind(c.email, c.contactUrl, p.id).run();
    } else {
      await env.DB.prepare("UPDATE link_prospects SET status = 'no-contact', contact_url = ?, updated_at = datetime('now') WHERE id = ?").bind(c.contactUrl, p.id).run();
    }
    await logEvent(env, p.id, 'contact', c.email || (c.contactUrl ? `form: ${c.contactUrl}` : 'none found'));
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// Drafting

const DRAFT_SYSTEM = `You write short outreach emails for Wellness Whizz (aiww.io), sent by its founder from hello@aiww.io, asking an editor or site owner to link to one specific free page. Rules:
- 90 to 130 words. Plain, specific, friendly, no flattery that could apply to any site, no exclamation marks, no emoji, no em dashes.
- Open with one concrete observation about THEIR page (what it lists or covers), then offer the ONE asset that fits it best, with its URL, and say in one sentence why their readers would use it.
- Make the ask explicit and small ("if it fits your resources page, a link would be appreciated" / "happy to write a 700-word piece on X for you if guest posts are open").
- No attachments, no tracking talk, no pressure. End with a one-line opt-out: "If this isn't relevant, a one-word 'no' is enough and I won't write again."
- Sign with the first name given, then "Wellness Whizz, aiww.io".
- Subject: at most 60 characters, specific, no clickbait.
- Write in the site's language (English or Spanish).`;

const draftSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    asset_path: { type: 'string', description: 'Path of the Wellness Whizz page being offered, one of the listed assets.' },
    subject: { type: 'string' },
    body: { type: 'string', description: 'Plain text with line breaks; no HTML.' },
  },
  required: ['asset_path', 'subject', 'body'],
};

export async function draftEmail(env: BacklinkEnv, p: Prospect): Promise<{ asset: string; subject: string; body: string }> {
  const name = (env.OUTREACH_SIGNATURE ?? '').trim() || 'Anton';
  if (env.DEV_FAKE_AI === 'true') {
    return { asset: '/', subject: `A free supplement quiz for your ${p.title || 'resources'} page`, body: `Hi,\n\nI saw your page "${p.title}" and thought ${origin(env)}/ might fit.\n\nIf this isn't relevant, a one-word 'no' is enough and I won't write again.\n\n${name}\nWellness Whizz, aiww.io` };
  }
  const page = (await fetchText(p.url, 120_000)).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000);
  const user = `${SITE_BRIEF}

Assets we can offer (path: what it is):
${ASSETS.map((a) => `${origin(env)}${a.path}: ${a.pitch}`).join('\n')}

Prospect: ${p.title} (${p.url}), kind: ${p.kind}, language: ${p.language}. Why it fits: ${p.why}
${p.contact_name ? `Contact name: ${p.contact_name}` : 'No contact name known: do not invent one; open with "Hi," or "Hola,".'}
Their page text (excerpt): ${page || '(could not be fetched)'}

Sender first name: ${name}. Write the email.`;
  const d = await claudeJson<{ asset_path: string; subject: string; body: string }>(env, DRAFT_SYSTEM, user, draftSchema, { tier: 'fast', maxTokens: 1200, timeoutMs: 60_000 });
  const asset = ASSETS.find((a) => d.asset_path.endsWith(a.path))?.path ?? d.asset_path;
  return { asset, subject: d.subject.replace(/[—–]/g, '-').slice(0, 80), body: d.body.replace(/\s*[—–]\s*/g, ', ').replace(/!/g, '.').trim() };
}

export async function draftPending(env: BacklinkEnv, limit = 8): Promise<number> {
  const rows = (await env.DB.prepare("SELECT * FROM link_prospects WHERE status = 'new' AND contact_email != '' ORDER BY score DESC, id LIMIT ?").bind(limit).all<Prospect>()).results;
  let n = 0;
  for (const p of rows) {
    try {
      const d = await draftEmail(env, p);
      await env.DB.prepare("UPDATE link_prospects SET status = 'drafted', asset = ?, draft_subject = ?, draft_body = ?, updated_at = datetime('now') WHERE id = ?").bind(d.asset, d.subject, d.body, p.id).run();
      await logEvent(env, p.id, 'drafted', d.subject);
      n++;
    } catch (err) {
      await logEvent(env, p.id, 'draft-failed', String(err).slice(0, 300));
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sending, follow-ups, replies, wins

function perDay(env: BacklinkEnv): number {
  const n = Number(env.OUTREACH_PER_DAY ?? '10');
  return Number.isFinite(n) ? Math.max(0, Math.min(50, n)) : 10;
}

async function sentToday(env: BacklinkEnv): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM link_events WHERE kind IN ('sent', 'follow-up') AND at > datetime('now', '-1 day')").first<{ n: number }>();
  return r?.n ?? 0;
}

function textToHtml(text: string): string {
  const esc = text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch] as string));
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1d272d;max-width:620px">${esc.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
}

/** Send approved drafts (or every draft when OUTREACH_AUTOSEND=true), within the daily cap. */
export async function sendApproved(env: BacklinkEnv, limit = 50): Promise<{ sent: number; skipped: string }> {
  if (!emailEnabled(env)) return { sent: 0, skipped: 'email is not configured' };
  const cap = perDay(env);
  const room = Math.min(limit, cap - (await sentToday(env)));
  if (room <= 0) return { sent: 0, skipped: cap ? 'daily cap reached' : 'sending paused (OUTREACH_PER_DAY=0)' };
  const auto = env.OUTREACH_AUTOSEND === 'true';
  const rows = (await env.DB.prepare(`SELECT * FROM link_prospects WHERE status = 'drafted' AND contact_email != '' ${auto ? '' : 'AND approved = 1'} ORDER BY score DESC, id LIMIT ?`).bind(room).all<Prospect>()).results;
  let sent = 0;
  for (const p of rows) {
    const id = await sendEmail(env, p.contact_email, p.draft_subject, textToHtml(p.draft_body), p.draft_body);
    if (!id) {
      await logEvent(env, p.id, 'send-failed', 'Resend returned no id');
      continue;
    }
    await env.DB.prepare("UPDATE link_prospects SET status = 'sent', sent_at = datetime('now'), followup_at = datetime('now', '+6 days'), updated_at = datetime('now') WHERE id = ?").bind(p.id).run();
    await logEvent(env, p.id, 'sent', `${p.contact_email} (${id})`);
    sent++;
  }
  return { sent, skipped: '' };
}

export async function sendFollowUps(env: BacklinkEnv, limit = 50): Promise<number> {
  if (!emailEnabled(env)) return 0;
  const room = Math.min(limit, perDay(env) - (await sentToday(env)));
  if (room <= 0) return 0;
  const name = (env.OUTREACH_SIGNATURE ?? '').trim() || 'Anton';
  const rows = (await env.DB.prepare("SELECT * FROM link_prospects WHERE status = 'sent' AND followup_at IS NOT NULL AND followup_at < datetime('now') ORDER BY followup_at LIMIT ?").bind(room).all<Prospect>()).results;
  let n = 0;
  for (const p of rows) {
    const es = p.language === 'es';
    const body = es
      ? `Hola,\n\nUn breve recordatorio por si mi mensaje de la semana pasada se perdió: ${origin(env)}${p.asset || '/'} es gratuito y podría encajar en ${p.title || 'vuestra página'}.\n\nSi no es relevante, con un "no" basta y no volveré a escribir.\n\n${name}\nWellness Whizz, aiww.io`
      : `Hi,\n\nA short nudge in case last week's note got buried: ${origin(env)}${p.asset || '/'} is free and might fit ${p.title || 'your page'}.\n\nIf it isn't relevant, a one-word "no" is enough and I won't write again.\n\n${name}\nWellness Whizz, aiww.io`;
    const subject = `Re: ${p.draft_subject}`.slice(0, 80);
    const id = await sendEmail(env, p.contact_email, subject, textToHtml(body), body);
    if (!id) continue;
    await env.DB.prepare("UPDATE link_prospects SET status = 'followed-up', followup_at = NULL, updated_at = datetime('now') WHERE id = ?").bind(p.id).run();
    await logEvent(env, p.id, 'follow-up', `${p.contact_email} (${id})`);
    n++;
  }
  return n;
}

/** Inbound mail from a prospect's domain (or address) counts as a reply. Returns the prospect it matched. */
export async function noteReply(env: BacklinkEnv, fromAddress: string, subject: string): Promise<Prospect | null> {
  const addr = fromAddress.toLowerCase();
  const domain = addr.split('@')[1] ?? '';
  if (!domain) return null;
  const p = await env.DB.prepare("SELECT * FROM link_prospects WHERE status IN ('sent', 'followed-up', 'replied', 'won') AND (contact_email = ? OR domain = ? OR domain = ?) ORDER BY sent_at DESC LIMIT 1")
    .bind(addr, domain, domain.replace(/^mail\./, '')).first<Prospect>();
  if (!p) return null;
  if (p.status === 'sent' || p.status === 'followed-up') {
    await env.DB.prepare("UPDATE link_prospects SET status = 'replied', replied_at = datetime('now'), followup_at = NULL, updated_at = datetime('now') WHERE id = ?").bind(p.id).run();
  }
  await logEvent(env, p.id, 'reply', `${addr}: ${subject.slice(0, 120)}`);
  return p;
}

/** Look for a link to the site on the prospect's page (and home page); mark the win. */
export async function checkWins(env: BacklinkEnv, limit = 25): Promise<number> {
  const rows = (await env.DB.prepare("SELECT * FROM link_prospects WHERE status IN ('sent', 'followed-up', 'replied') ORDER BY updated_at LIMIT ?").bind(limit).all<Prospect>()).results;
  let won = 0;
  for (const p of rows) {
    for (const u of [p.url, `https://${p.domain}`]) {
      const html = await fetchText(u, 400_000);
      if (/href="https?:\/\/(www\.)?aiww\.io/i.test(html)) {
        await env.DB.prepare("UPDATE link_prospects SET status = 'won', won_url = ?, updated_at = datetime('now') WHERE id = ?").bind(u, p.id).run();
        await logEvent(env, p.id, 'won', u);
        won++;
        break;
      }
    }
    await env.DB.prepare("UPDATE link_prospects SET updated_at = datetime('now') WHERE id = ?").bind(p.id).run();
  }
  return won;
}

export async function logEvent(env: BacklinkEnv, prospectId: number, kind: string, detail: string): Promise<void> {
  await env.DB.prepare("INSERT INTO link_events (prospect_id, at, kind, detail) VALUES (?, datetime('now'), ?, ?)").bind(prospectId, kind, detail.slice(0, 500)).run();
}

export interface LinkEvent { prospect_id: number; at: string; kind: string; detail: string }

/** The last few events per prospect (lookups, drafts, sends, failures) for the admin page and the list JSON. */
export async function recentEvents(env: BacklinkEnv, ids: number[], per = 3): Promise<Record<number, LinkEvent[]>> {
  const out: Record<number, LinkEvent[]> = {};
  const some = ids.slice(0, 200);
  if (!some.length) return out;
  const rows = (await env.DB.prepare(`SELECT prospect_id, at, kind, detail FROM link_events WHERE prospect_id IN (${some.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 800`).bind(...some).all<LinkEvent>()).results;
  for (const e of rows) {
    const list = (out[e.prospect_id] ??= []);
    if (list.length < per) list.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Daily run and reporting

export interface OutreachSummary { discovered: { theme: string; found: number; added: number } | null; contacts: number; drafted: number; sent: number; skipped: string; followUps: number; awaiting: number; errors: string[] }

/** What happened in the last 24 hours, read back from the event log (the work is spread over the day's ticks). */
async function daySummary(env: BacklinkEnv): Promise<Pick<OutreachSummary, 'contacts' | 'drafted' | 'sent' | 'followUps'> & { failures: string[] }> {
  const rows = (await env.DB.prepare("SELECT kind, detail FROM link_events WHERE at > datetime('now', '-1 day') ORDER BY id").all<{ kind: string; detail: string }>()).results;
  const s = { contacts: 0, drafted: 0, sent: 0, followUps: 0, failures: [] as string[] };
  for (const r of rows) {
    if (r.kind === 'contact' && r.detail.includes('@')) s.contacts++;
    else if (r.kind === 'drafted') s.drafted++;
    else if (r.kind === 'sent') s.sent++;
    else if (r.kind === 'follow-up') s.followUps++;
    else if (r.kind.endsWith('-failed') && s.failures.length < 3) s.failures.push(`${r.kind}: ${r.detail.slice(0, 120)}`);
  }
  return s;
}

/**
 * One small unit of outreach work for the five-minute tick: two contact lookups, else two drafts, else (weekdays 07:00
 * to 17:00 UTC, within the daily cap) up to two sends or follow-ups. The daily run used to do all of it in one go and the
 * plan's per-invocation CPU budget cut it off before the drafts; spread out, a tick fetches at most two pages.
 * Returns a short note of what it did, or null when there was nothing to do.
 */
export async function outreachStep(env: BacklinkEnv): Promise<string | null> {
  const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
  if (await count("SELECT COUNT(*) AS n FROM link_prospects WHERE status = 'new' AND contact_email = ''")) return `contacts: ${await findContacts(env, 2)} of 2 found`;
  if (await count("SELECT COUNT(*) AS n FROM link_prospects WHERE status = 'new' AND contact_email != ''")) return `drafted ${await draftPending(env, 2)}`;
  const now = new Date();
  const day = now.getUTCDay(), hour = now.getUTCHours();
  if (day === 0 || day === 6 || hour < 7 || hour >= 17) return null;
  const { sent } = await sendApproved(env, 2);
  if (sent) return `sent ${sent}`;
  const followUps = await sendFollowUps(env, 2);
  return followUps ? `follow-ups ${followUps}` : null;
}

/**
 * The daily run (06:00 UTC): discover one theme's prospects, then summarise the last 24 hours for the digest. The
 * contact, draft, send and follow-up steps run from the five-minute ticks (outreachStep); `work: true` (the manual "run
 * everything" button) does them here as well.
 */
export async function dailyOutreach(env: BacklinkEnv, opts: { discover?: boolean; work?: boolean } = {}): Promise<OutreachSummary> {
  const errors: string[] = [];
  let discovered: OutreachSummary['discovered'] = null;
  if (opts.discover !== false) {
    try { discovered = await discoverProspects(env); } catch (err) { errors.push(`discover: ${String(err).slice(0, 200)}`); }
  }
  let skipped = '';
  if (opts.work) {
    try { await findContacts(env); } catch (err) { errors.push(`contacts: ${String(err).slice(0, 200)}`); }
    try { await draftPending(env); } catch (err) { errors.push(`draft: ${String(err).slice(0, 200)}`); }
    try { ({ skipped } = await sendApproved(env)); } catch (err) { errors.push(`send: ${String(err).slice(0, 200)}`); }
    try { await sendFollowUps(env); } catch (err) { errors.push(`follow-up: ${String(err).slice(0, 200)}`); }
  }
  const day = await daySummary(env);
  const awaiting = (await env.DB.prepare("SELECT COUNT(*) AS n FROM link_prospects WHERE status = 'drafted' AND approved = 0").first<{ n: number }>())?.n ?? 0;
  return { discovered, contacts: day.contacts, drafted: day.drafted, sent: day.sent, skipped, followUps: day.followUps, awaiting, errors: [...errors, ...day.failures] };
}

export async function counts(env: BacklinkEnv): Promise<Record<string, number>> {
  const r = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM link_prospects GROUP BY status').all<{ status: string; n: number }>();
  const out: Record<string, number> = {};
  for (const row of r.results) out[row.status] = row.n;
  return out;
}

export async function listProspects(env: BacklinkEnv, status?: string, limit = 200): Promise<Prospect[]> {
  const q = status
    ? env.DB.prepare('SELECT * FROM link_prospects WHERE status = ? ORDER BY updated_at DESC LIMIT ?').bind(status, limit)
    : env.DB.prepare('SELECT * FROM link_prospects ORDER BY updated_at DESC LIMIT ?').bind(limit);
  return (await q.all<Prospect>()).results;
}

export async function getProspect(env: BacklinkEnv, id: number): Promise<Prospect | null> {
  return (await env.DB.prepare('SELECT * FROM link_prospects WHERE id = ?').bind(id).first<Prospect>()) ?? null;
}

/** Owner actions from the admin page. */
export async function actOnProspect(env: BacklinkEnv, id: number, action: string, fields: { subject?: string; body?: string; email?: string } = {}): Promise<string> {
  const p = await getProspect(env, id);
  if (!p) return 'not found';
  const now = "datetime('now')";
  switch (action) {
    case 'approve':
      await env.DB.prepare(`UPDATE link_prospects SET approved = 1, draft_subject = COALESCE(?, draft_subject), draft_body = COALESCE(?, draft_body), contact_email = COALESCE(?, contact_email), updated_at = ${now} WHERE id = ?`)
        .bind(fields.subject ?? null, fields.body ?? null, fields.email ?? null, id).run();
      return 'approved';
    case 'send': {
      await actOnProspect(env, id, 'approve', fields);
      const prev = env.OUTREACH_AUTOSEND;
      const r = await sendApproved({ ...env, OUTREACH_AUTOSEND: prev });
      return r.sent ? 'sent' : `not sent: ${r.skipped || 'cap or email setup'}`;
    }
    case 'skip':
      await env.DB.prepare(`UPDATE link_prospects SET status = 'skipped', approved = 0, updated_at = ${now} WHERE id = ?`).bind(id).run();
      return 'skipped';
    case 'redraft':
      await env.DB.prepare(`UPDATE link_prospects SET status = 'new', approved = 0, draft_subject = '', draft_body = '', updated_at = ${now} WHERE id = ?`).bind(id).run();
      return 'queued for a new draft';
    case 'won':
      await env.DB.prepare(`UPDATE link_prospects SET status = 'won', won_url = COALESCE(?, won_url), updated_at = ${now} WHERE id = ?`).bind(fields.body ?? null, id).run();
      return 'marked won';
    case 'declined':
      await env.DB.prepare(`UPDATE link_prospects SET status = 'declined', updated_at = ${now} WHERE id = ?`).bind(id).run();
      return 'marked declined';
    case 'contact': {
      const email = (fields.email ?? '').trim().toLowerCase();
      if (!email) {
        await env.DB.prepare(`UPDATE link_prospects SET contact_email = '', approved = 0, status = 'no-contact', draft_subject = '', draft_body = '', updated_at = ${now} WHERE id = ?`).bind(id).run();
        return 'address cleared';
      }
      await env.DB.prepare(`UPDATE link_prospects SET contact_email = ?, status = CASE WHEN status = 'no-contact' THEN 'new' ELSE status END, updated_at = ${now} WHERE id = ?`).bind(email, id).run();
      return 'contact saved';
    }
    default:
      return 'unknown action';
  }
}

export async function addProspect(env: BacklinkEnv, url: string, kind: ProspectKind, note: string): Promise<string> {
  const domain = domainOf(url);
  if (!domain) return 'bad url';
  const exists = await env.DB.prepare('SELECT id FROM link_prospects WHERE domain = ?').bind(domain).first();
  if (exists) return 'already listed';
  await env.DB.prepare(`INSERT INTO link_prospects (domain, url, kind, title, why, language, score, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'en', 60, 'manual', 'new', datetime('now'), datetime('now'))`)
    .bind(domain, url, kind, domain, note.slice(0, 500)).run();
  return 'added';
}

export async function outreachDigest(env: BacklinkEnv, s: OutreachSummary): Promise<void> {
  if (!emailEnabled(env)) return;
  const to = (env.DIGEST_TO ?? '').trim() || alertRecipient(env);
  if (!to) return;
  if (!s.awaiting && !s.sent && !s.followUps && !s.drafted && !s.errors.length) return;
  const page = `${origin(env)}/api/admin/backlinks?key=${encodeURIComponent(env.STATS_KEY ?? '')}`;
  const lines = [
    s.discovered ? `Discovered ${s.discovered.added} new prospects (${s.discovered.theme}).` : '',
    `Last 24 hours: contacts found ${s.contacts}, drafts written ${s.drafted}, pitches sent ${s.sent}${s.skipped ? ` (${s.skipped})` : ''}, follow-ups ${s.followUps}.`,
    s.awaiting ? `${s.awaiting} draft${s.awaiting === 1 ? '' : 's'} waiting for your approval.` : '',
    ...s.errors.map((e) => `Problem: ${e}`),
  ].filter(Boolean);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1d272d;max-width:620px">${lines.map((l) => `<p style="margin:0 0 8px">${l.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch] as string))}</p>`).join('')}<p style="margin:16px 0"><a href="${page}" style="display:inline-block;background:#1d272d;color:#fff;text-decoration:none;border-radius:10px;padding:12px 18px">Review the outreach</a></p></div>`;
  await sendEmail(env, to, s.awaiting ? `Backlinks: ${s.awaiting} pitch${s.awaiting === 1 ? '' : 'es'} to approve` : 'Backlinks: daily outreach report', html, `${lines.join('\n')}\n\n${page}`);
}
