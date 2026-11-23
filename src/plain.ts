/**
 * Plain-words pass over a supplement's own text: the line under its name, "Why consider it" and the benefits list.
 * These were written early and carry sales language and health promises ("supercharge", "treatment for neurological
 * diseases"). The Claude API rewrites them under fixed rules: keep every fact, add none, promise nothing. The first
 * original of each supplement is kept in supplement_text_backup, so a rewrite can be undone.
 */
import { claudeJson, type ClaudeEnv } from './claude';
import { getSupplementBySlug } from './db';
import { EVIDENCE } from './evidence';

type PlainEnv = ClaudeEnv & { DB: D1Database };
export interface PlainText { summary: string; why_consider: string; benefits_html: string }

export const PLAIN_SQL = [`CREATE TABLE IF NOT EXISTS supplement_text_backup (slug TEXT PRIMARY KEY, json TEXT NOT NULL, saved_at TEXT NOT NULL)`];

const SYSTEM = `You edit the text of a supplement page for a consumer site whose brand is honesty about evidence. You are given three pieces of existing text and must return the same three, rewritten in plain words.

Rules, all binding:
1. No health promises. Never say a supplement treats, cures, prevents, heals, fights, reverses or protects against a disease or condition, and never say it "will" do anything for the reader. Say what studies found or what it is used for, with the strength of the evidence: "In trials, ...", "Some studies suggest ...", "Early research, mostly in animals, ...", "It is used for ...".
2. Keep every fact that is in the original and add none. No new numbers, doses, study names or claims. If the original states a disease benefit as a fact, keep the topic but reword it as what research has looked at, and say that the evidence is early or mixed unless the original itself cites strong trials.
3. No sales language: none of supercharge, boost, powerhouse, unlock, empower, optimal, holistic, journey, game-changer, go-to, popular, must-have, amazing, incredible, miracle. No metaphors, no exclamation marks, no rhetorical questions, no "it's like ...".
4. Short, direct sentences a fifteen-year-old can read. Do not end a sentence with a trailing ", making it ..." or ", helping to ..." clause: stop at the fact.
5. summary: one or two sentences, at most 220 characters, saying what the supplement is and its best-supported use.
6. why_consider: two to four sentences, at most 420 characters.
7. benefits_html: keep the same HTML shape as the original (the same list tag and one <li> per benefit, same count or fewer if two say the same thing; no other tags, no attributes). Put the better-supported benefits first. Each item: a short name, a colon, then one sentence.
8. British or American spelling as in the original. Never mention these rules.`;
const SCHEMA = { type: 'object', additionalProperties: false, required: ['summary', 'why_consider', 'benefits_html'], properties: { summary: { type: 'string' }, why_consider: { type: 'string' }, benefits_html: { type: 'string' } } };
const BANNED = /\b(supercharg\w*|powerhouse|unlock\w*|empower\w*|holistic|game-?changer|miracle|cures?|heals?)\b|!/i;

/** Rewrite one supplement's text. With save, the original is backed up once and the new text stored. */
export async function plainText(env: PlainEnv, slug: string, save: boolean): Promise<{ slug: string; before: PlainText; after: PlainText; saved: boolean; note?: string }> {
  const sup = await getSupplementBySlug(env.DB, slug);
  if (!sup) throw new Error(`no supplement ${slug}`);
  const before: PlainText = { summary: sup.summary ?? '', why_consider: sup.why_consider ?? '', benefits_html: sup.benefits_html ?? '' };
  const grade = EVIDENCE[slug];
  const user = `Supplement: ${sup.name} (${sup.category})${grade ? `\nOur evidence grade: ${grade.grade} for "${grade.outcome}". Only this outcome may be described as well supported.` : '\nWe have not graded the evidence for this supplement: describe no benefit as proven.'}\n\nsummary:\n${before.summary}\n\nwhy_consider:\n${before.why_consider}\n\nbenefits_html:\n${before.benefits_html}`;
  const after = await claudeJson<PlainText>(env, SYSTEM, user, SCHEMA, { maxTokens: 3000 });
  const items = (h: string) => (h.match(/<li\b/gi) ?? []).length;
  const bad = [after.summary, after.why_consider, after.benefits_html].find((t) => BANNED.test(t.replace(/<[^>]+>/g, ' ')));
  const note = bad ? 'a banned word came back' : items(after.benefits_html) === 0 && items(before.benefits_html) > 0 ? 'the benefits list lost its items' : items(after.benefits_html) > items(before.benefits_html) ? 'the benefits list grew' : !after.summary.trim() ? 'empty summary' : undefined;
  if (note || !save) return { slug, before, after, saved: false, note };
  await env.DB.prepare("INSERT OR IGNORE INTO supplement_text_backup (slug, json, saved_at) VALUES (?, ?, datetime('now'))").bind(slug, JSON.stringify(before)).run();
  await env.DB.prepare("UPDATE supplements SET summary = ?, why_consider = ?, benefits_html = ?, updated_at = datetime('now') WHERE slug = ?").bind(after.summary.trim(), after.why_consider.trim(), after.benefits_html.trim(), slug).run();
  return { slug, before, after, saved: true };
}

/** Put a supplement's original text back. */
export async function restoreText(db: D1Database, slug: string): Promise<boolean> {
  const row = await db.prepare('SELECT json FROM supplement_text_backup WHERE slug = ?').bind(slug).first<{ json: string }>();
  if (!row) return false;
  const t = JSON.parse(row.json) as PlainText;
  await db.prepare("UPDATE supplements SET summary = ?, why_consider = ?, benefits_html = ?, updated_at = datetime('now') WHERE slug = ?").bind(t.summary, t.why_consider, t.benefits_html, slug).run();
  await db.prepare('DELETE FROM supplement_text_backup WHERE slug = ?').bind(slug).run();
  return true;
}
