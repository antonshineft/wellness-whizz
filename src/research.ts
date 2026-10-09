/**
 * Research notes: new randomised trials, meta-analyses and systematic reviews about catalogue supplements, found
 * on PubMed (free E-utilities) and summarised in plain language by the model. Shown on /research and posted to X.
 */
import type { Supplement } from './db';
import { escapeHtml } from './html';
import { chatJson, useFakeAi, type AiEnv } from './openai';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

export interface ResearchEnv extends AiEnv {
  DB: D1Database;
  NCBI_API_KEY?: string;
}

export interface ResearchNote {
  id: number;
  pmid: string;
  supplement_id: number;
  title: string;
  journal: string;
  pub_date: string;
  pub_type: string;
  summary: string;
  takeaway: string;
  tweet: string;
  queued: number;
  created_at: string;
  /** joined */
  supplement_name?: string;
  supplement_slug?: string;
  supplement_category?: string;
}

interface PubmedSummary {
  uid: string;
  title: string;
  fulljournalname?: string;
  source?: string;
  pubdate?: string;
  pubtype?: string[];
}

const HEADERS = { 'user-agent': 'WellnessWhizz/1.0 (+https://aiww.io)' };

/** NCBI asks clients to identify themselves; an API key raises the rate limit from 3 to 10 requests a second. */
function withKey(env: ResearchEnv, url: string): string {
  const tagged = `${url}&tool=wellnesswhizz&email=hello%40aiww.io`;
  return env.NCBI_API_KEY ? `${tagged}&api_key=${encodeURIComponent(env.NCBI_API_KEY)}` : tagged;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * NCBI allows 3 requests a second per IP address without a key (10 with one) and answers 429 beyond that. The
 * search, the summaries and the abstract of one supplement used to go out within a second, so the abstract request
 * was the one refused. Every request now waits its turn, and a refused one is retried once after a pause.
 */
let lastRequest = 0;
async function ncbiFetch(env: ResearchEnv, url: string): Promise<Response> {
  const gap = env.NCBI_API_KEY ? 120 : 400;
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
    if (res.status !== 429 || attempt) return res;
    await sleep(1500);
  }
}

/** PubMed ids of recent trials and reviews whose title mentions the supplement. */

export async function searchPubmed(env: ResearchEnv, name: string, days = 90, max = 5): Promise<string[]> {
  // Oral dietary-supplement studies only: no intravenous, surgical or obstetric uses of the same molecule.
  const term =
    `(${name}[Title]) AND (supplement*[Title/Abstract] OR supplementation[Title/Abstract] OR oral[Title/Abstract] OR dietary[Title/Abstract]) ` +
    'AND (randomized controlled trial[pt] OR meta-analysis[pt] OR systematic review[pt]) AND humans[mh] ' +
    'NOT (intravenous[Title] OR infusion[Title] OR anesthesia[Title] OR anaesthesia[Title] OR surgery[Title] OR surgical[Title] OR preterm[Title] OR intensive care[Title])';
  const url = withKey(env, `${EUTILS}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&reldate=${days}&datetype=pdat&retmode=json&retmax=${max}`);
  const res = await ncbiFetch(env, url);
  if (!res.ok) throw new Error(`PubMed esearch ${res.status}`);
  const data = (await res.json()) as { esearchresult?: { idlist?: string[] } };
  return data.esearchresult?.idlist ?? [];
}

export async function pubmedSummaries(env: ResearchEnv, pmids: string[]): Promise<PubmedSummary[]> {
  if (!pmids.length) return [];
  const url = withKey(env, `${EUTILS}/esummary.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=json`);
  const res = await ncbiFetch(env, url);
  if (!res.ok) throw new Error(`PubMed esummary ${res.status}`);
  const data = (await res.json()) as { result?: Record<string, PubmedSummary | string[]> };
  return pmids.map((id) => data.result?.[id]).filter((r): r is PubmedSummary => !!r && typeof r === 'object' && 'title' in r);
}

export interface PubmedArticle {
  /** Abstract text (first ~2500 characters); empty when PubMed has none. */
  abstract: string;
  /** Publication types as PubMed lists them, e.g. "Randomized Controlled Trial". */
  pubTypes: string[];
}

/**
 * Abstract and publication types from efetch XML. Throws when PubMed does not answer properly (a rate limit, an
 * outage), so the paper is tried again another day instead of being filed as having no abstract.
 */
export async function pubmedArticle(env: ResearchEnv, pmid: string): Promise<PubmedArticle> {
  const url = withKey(env, `${EUTILS}/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`);
  const res = await ncbiFetch(env, url);
  if (!res.ok) throw new Error(`PubMed efetch ${res.status}`);
  const xml = await res.text();
  if (!/<Pubmed(Book)?Article[\s>]/.test(xml)) throw new Error('PubMed efetch: no article in the answer');
  const parts = [...xml.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' '));
  const pubTypes = [...xml.matchAll(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/g)].map((m) => m[1].trim()).filter((t) => t && t !== 'Journal Article');
  return { abstract: parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 2500), pubTypes };
}

/** Abstract text only; see pubmedArticle. */
export async function pubmedAbstract(env: ResearchEnv, pmid: string): Promise<string> {
  return (await pubmedArticle(env, pmid)).abstract;
}

const noteSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    relevant: { type: 'boolean', description: 'true only if the paper is about taking this supplement by mouth as a dietary supplement (not intravenous, hospital, surgical or obstetric use).' },
    summary: { type: 'string', description: 'Two or three plain-language sentences: who was studied, what was given, what was found. No hype.' },
    takeaway: { type: 'string', description: 'One cautious sentence on what this means for someone considering the supplement.' },
    tweet: { type: 'string', description: 'A post for X of at most 200 characters: the finding in plain words, no hashtags, no emoji, no URL.' },
  },
  required: ['relevant', 'summary', 'takeaway', 'tweet'],
} as const;

interface NoteDraft {
  relevant: boolean;
  summary: string;
  takeaway: string;
  tweet: string;
}

async function draftNote(env: ResearchEnv, sup: Pick<Supplement, 'name'>, s: PubmedSummary, abstractText: string): Promise<NoteDraft> {
  if (useFakeAi(env)) {
    return {
      relevant: true,
      summary: `[Dev mode] Summary of "${s.title}" for ${sup.name}.`,
      takeaway: `[Dev mode] Takeaway for ${sup.name}.`,
      tweet: `New ${sup.name} study: ${s.title.slice(0, 120)}`,
    };
  }
  const user = [
    `Summarise this peer-reviewed paper about the supplement "${sup.name}" for a general audience.`,
    `Title: ${s.title}`,
    `Journal: ${s.fulljournalname || s.source || ''} (${s.pubdate || ''}); type: ${(s.pubtype || []).join(', ')}`,
    abstractText ? `Abstract: ${abstractText}` : 'No abstract available: summarise from the title only and say that the abstract was not available.',
    'Tone: calm, evidence-based, no medical advice, no claims of curing or treating. Mention sample size and duration when given.',
  ].join('\n');
  return chatJson<NoteDraft>(env, 'research_note', noteSchema, user);
}

export async function insertNote(db: D1Database, sup: Supplement, s: PubmedSummary, draft: NoteDraft): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO research_notes (pmid, supplement_id, title, journal, pub_date, pub_type, summary, takeaway, tweet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(s.uid, sup.id, s.title, s.fulljournalname || s.source || '', s.pubdate || '', (s.pubtype || []).join(', '), draft.summary, draft.takeaway, draft.tweet)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Look for new papers about up to `batch` supplements (cursor in meta so the catalogue is cycled weekly). */
export async function researchBatch(env: ResearchEnv, supplements: Supplement[], batch: number): Promise<{ checked: string[]; added: string[]; failed: string[] }> {
  const checked: string[] = [];
  const added: string[] = [];
  const failed: string[] = [];
  const known = new Set((await env.DB.prepare('SELECT pmid FROM research_notes').all<{ pmid: string }>()).results.map((r) => r.pmid));
  for (const sup of supplements.slice(0, batch)) {
    checked.push(sup.slug);
    try {
      const ids = (await searchPubmed(env, sup.name)).filter((id) => !known.has(id)).slice(0, 2);
      if (!ids.length) continue;
      const summaries = await pubmedSummaries(env, ids);
      for (const s of summaries) {
        const abstractText = await pubmedAbstract(env, s.uid);
        known.add(s.uid);
        if (!abstractText) {
          // Nothing to summarise from a title alone: remember the id, keep it off the page and off X
          // (repairNotes looks again later: PubMed sometimes adds the abstract days after the citation).
          await env.DB.prepare('INSERT OR IGNORE INTO research_notes (pmid, supplement_id, title, journal, pub_date, pub_type, summary, takeaway, tweet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(s.uid, sup.id, s.title, s.fulljournalname || s.source || '', s.pubdate || '', 'no-abstract', '', '', '')
            .run();
          continue;
        }
        const draft = await draftNote(env, sup, s, abstractText);
        if (!draft.relevant) {
          // Remember the id so it is not re-summarised next week, but keep it off the page.
          await env.DB.prepare('INSERT OR IGNORE INTO research_notes (pmid, supplement_id, title, journal, pub_date, pub_type, summary, takeaway, tweet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(s.uid, sup.id, s.title, s.fulljournalname || s.source || '', s.pubdate || '', 'not-relevant', '', '', '')
            .run();
          continue;
        }
        if (await insertNote(env.DB, sup, s, draft)) added.push(`${sup.slug}:${s.uid}`);
      }
    } catch (err) {
      failed.push(`${sup.slug}: ${String(err).slice(0, 120)}`);
    }
  }
  return { checked, added, failed };
}

/**
 * A second look at papers filed without an abstract, by the daily run or by pruneAbstractlessNotes: PubMed often adds
 * the abstract days after the citation appears, and an earlier fetch may simply have failed. A note whose abstract is
 * there now is written like any other (and offered to the X queue); one still without is filed as checked and not
 * fetched again.
 */
export async function repairNotes(env: ResearchEnv, limit = 10): Promise<{ checked: number; filled: string[]; failed: string[] }> {
  const filled: string[] = [];
  const failed: string[] = [];
  const { results } = await env.DB
    .prepare(
      `SELECT n.*, s.name AS supplement_name, s.slug AS supplement_slug FROM research_notes n
       JOIN supplements s ON s.id = n.supplement_id WHERE n.summary = '' AND n.pub_type = 'no-abstract' ORDER BY n.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<ResearchNote>();
  for (const note of results) {
    try {
      const article = await pubmedArticle(env, note.pmid);
      if (!article.abstract) {
        await env.DB.prepare("UPDATE research_notes SET pub_type = 'no-abstract-checked' WHERE id = ?").bind(note.id).run();
        continue;
      }
      const summary: PubmedSummary = { uid: note.pmid, title: note.title, fulljournalname: note.journal, pubdate: note.pub_date, pubtype: article.pubTypes };
      const draft = await draftNote(env, { name: note.supplement_name ?? '' }, summary, article.abstract);
      if (!draft.relevant) {
        await env.DB.prepare("UPDATE research_notes SET pub_type = 'not-relevant' WHERE id = ?").bind(note.id).run();
        continue;
      }
      await env.DB
        .prepare('UPDATE research_notes SET summary = ?, takeaway = ?, tweet = ?, pub_type = ?, queued = 0 WHERE id = ?')
        .bind(draft.summary, draft.takeaway, draft.tweet, article.pubTypes.join(', '), note.id)
        .run();
      filled.push(`${note.supplement_slug}:${note.pmid}`);
    } catch (err) {
      failed.push(`${note.pmid}: ${String(err).slice(0, 120)}`);
    }
  }
  return { checked: results.length, filled, failed };
}

/**
 * Notes written before abstracts were required say things like "the abstract was not available"; take them off the
 * page and out of the X queue. Returns how many were pruned.
 */
export async function pruneAbstractlessNotes(db: D1Database): Promise<{ notes: number; posts: number }> {
  const notes = await db
    .prepare(
      `UPDATE research_notes SET summary = '', takeaway = '', tweet = '', pub_type = 'no-abstract'
       WHERE summary != '' AND (summary LIKE '%abstract%not available%' OR summary LIKE '%abstract was not available%'
         OR tweet LIKE '%not available from the summary%' OR tweet LIKE '%abstract%not available%' OR tweet LIKE '%abstract%unavailable%')`,
    )
    .run();
  const posts = await db
    .prepare("UPDATE social_posts SET status = 'skipped' WHERE kind = 'research' AND status = 'queued' AND ref IN (SELECT pmid FROM research_notes WHERE summary = '')")
    .run();
  return { notes: notes.meta?.changes ?? 0, posts: posts.meta?.changes ?? 0 };
}

export async function listResearchNotes(db: D1Database, limit = 100): Promise<ResearchNote[]> {
  const { results } = await db
    .prepare(
      `SELECT n.*, s.name AS supplement_name, s.slug AS supplement_slug, s.category AS supplement_category FROM research_notes n
       JOIN supplements s ON s.id = n.supplement_id WHERE n.summary != '' ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<ResearchNote>();
  return results;
}

export async function unqueuedNotes(db: D1Database, limit: number): Promise<ResearchNote[]> {
  const { results } = await db
    .prepare(
      `SELECT n.*, s.name AS supplement_name, s.slug AS supplement_slug FROM research_notes n
       JOIN supplements s ON s.id = n.supplement_id WHERE n.queued = 0 AND n.tweet != '' ORDER BY n.created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<ResearchNote>();
  return results;
}

export function pubmedUrl(pmid: string): string {
  return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;
}

export function noteLabel(n: ResearchNote): string {
  return escapeHtml([n.journal, n.pub_date].filter(Boolean).join(', '));
}
