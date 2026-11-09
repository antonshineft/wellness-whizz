/**
 * Winner feeds the writer. Once a week the trial results are turned into a short note that the script writer
 * (src/videos.ts writeScripts) reads before it writes new videos.
 *
 * The verdicts are computed here, not by the model: a format is favoured or avoided only after at least three tests
 * with enough views, so one lucky reel never changes the strategy. The Claude API is then asked only to put the
 * verdicts into the writer's terms, looking at the lines that won and lost. With no verdict there is no API call.
 */
import { claudeJson } from './claude';
import { getMeta, setMeta } from './db';
import { latestTwo, skipTest, type Snapshot } from './trialboard';
import { listTrials } from './trials';
import type { VideoEnv } from './videos';

/** Read by src/videos.ts (as a plain meta key, so the two modules do not import each other). */
export const LEARNED_KEY = 'video:learned';
const MIN_VIEWS = 300;
const MIN_TESTS = 3;
/** Average watch time has no sample behind it in Instagram's report, so an ending counts only beyond this many seconds. */
const WATCH_MARGIN = 1.5;

export interface FormatRecord {
  kind: 'hook' | 'ending';
  format: string;
  tests: number;
  wins: number;
  losses: number;
  /** Hooks: average change in "skipped in 3 s" against the original, in points (negative is better). Endings: seconds of average watch time (positive is better). */
  mean_change: number;
  verdict: 'favour' | 'avoid' | 'open';
  examples: { line: string; change: number; result: 'win' | 'loss' | 'even' }[];
}

export interface Learned {
  at: string;
  status: 'updated' | 'waiting' | 'no pattern';
  note: string;
  guidance: string;
  summary: string;
  formats: FormatRecord[];
}

const counted = (s: Snapshot | null): s is Snapshot => !!s && (s.views ?? 0) >= MIN_VIEWS;

/** Every finished test folded into one record per format. */
export async function trialEvidence(env: VideoEnv): Promise<FormatRecord[]> {
  const posted = (await listTrials(env.DB)).filter((r) => r.status === 'posted');
  const originals = new Map<string, Snapshot | null>();
  const records = new Map<string, FormatRecord>();
  for (const r of posted) {
    if (!originals.has(r.slug)) originals.set(r.slug, (await latestTwo(env.DB, `video:${r.slug}`))[0]);
    const orig = originals.get(r.slug) ?? null;
    const now = (await latestTwo(env.DB, `trial:${r.id}`))[0];
    if (!counted(now) || !counted(orig)) continue;
    let change: number;
    let result: 'win' | 'loss' | 'even' = 'even';
    if (r.kind === 'hook') {
      if (now.skip_rate === null || orig.skip_rate === null) continue;
      change = now.skip_rate - orig.skip_rate;
      if (skipTest(now, orig).significant) result = change < 0 ? 'win' : 'loss';
    } else {
      if (now.avg_watch === null || orig.avg_watch === null) continue;
      change = now.avg_watch - orig.avg_watch;
      if (Math.abs(change) >= WATCH_MARGIN) result = change > 0 ? 'win' : 'loss';
    }
    const key = `${r.kind}|${r.format}`;
    const rec = records.get(key) ?? { kind: r.kind, format: r.format, tests: 0, wins: 0, losses: 0, mean_change: 0, verdict: 'open' as const, examples: [] };
    rec.tests += 1;
    rec.wins += result === 'win' ? 1 : 0;
    rec.losses += result === 'loss' ? 1 : 0;
    rec.mean_change += change;
    rec.examples.push({ line: r.line, change: Math.round(change * 10) / 10, result });
    records.set(key, rec);
  }
  return [...records.values()].map((rec) => {
    const mean = rec.mean_change / rec.tests;
    const better = rec.kind === 'hook' ? mean < 0 : mean > 0;
    const verdict: FormatRecord['verdict'] = rec.tests >= MIN_TESTS && rec.wins >= 2 && rec.losses === 0 && better ? 'favour'
      : rec.tests >= MIN_TESTS && rec.losses >= 2 && rec.wins === 0 && !better ? 'avoid' : 'open';
    return { ...rec, mean_change: Math.round(mean * 10) / 10, verdict, examples: rec.examples.slice(-6) };
  }).sort((a, b) => (a.kind === b.kind ? b.tests - a.tests : a.kind === 'hook' ? -1 : 1));
}

export async function getLearned(db: D1Database): Promise<Learned | null> {
  try {
    const raw = await getMeta(db, LEARNED_KEY);
    return raw ? (JSON.parse(raw) as Learned) : null;
  } catch {
    return null;
  }
}

const LEARN_SYSTEM = `You keep a short note for a script writer who writes 90-second narrated explainer videos about supplements. The note tells the writer what tests on real Instagram viewers have shown about opening lines (scene 1) and closing lines (the last scene).

You are given verdicts that were computed from the test numbers: formats to favour, formats to avoid, with the actual lines that were tested and how each did. Write the note from the verdicts only.
- Say what to do in the writer's terms: describe what the winning lines have in common (their first words, what they name, how they pose the gap) and what the losing ones have in common. Quote no numbers.
- Never recommend or discourage a format that is not in the verdicts. Never invent a reason the lines do not show.
- The note must not ask for anything the writer's standing rules forbid: no doses, no health promises, no calls to action, no stock phrases.
- Keep variety alive: the note says what to lean towards, it never tells the writer to open every video the same way.
- guidance: at most 110 words, plain sentences, addressed to the writer. summary: two or three plain sentences for the owner, saying what changed this week and on how many tests it rests.`;

const learnSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { guidance: { type: 'string' }, summary: { type: 'string' } },
  required: ['guidance', 'summary'],
};

/** The weekly step: recompute the verdicts and, when there is one, have the Claude API rewrite the writer's note. */
export async function learnFromTrials(env: VideoEnv): Promise<Learned> {
  const formats = await trialEvidence(env);
  const previous = await getLearned(env.DB);
  const decided = formats.filter((f) => f.verdict !== 'open');
  const base = { at: new Date().toISOString(), formats, guidance: previous?.guidance ?? '', summary: previous?.summary ?? '' };
  let learned: Learned;
  if (!decided.length) {
    const most = formats.reduce((m, f) => Math.max(m, f.tests), 0);
    learned = most < MIN_TESTS
      ? { ...base, status: 'waiting', note: `No format has ${MIN_TESTS} finished tests yet (the most tested has ${most}). A test counts once the original and the variation each have ${MIN_VIEWS} views.` }
      : { ...base, status: 'no pattern', note: 'Enough tests, but no format has won or lost consistently, so the writer keeps its current rules.' };
  } else {
    const user = decided.map((f) => `${f.verdict.toUpperCase()} the ${f.kind === 'hook' ? 'opening' : 'ending'} format "${f.format}" (${f.tests} tests, ${f.wins} clear wins, ${f.losses} clear losses):\n${f.examples.map((e) => `- [${e.result}] ${e.line}`).join('\n')}`).join('\n\n');
    const out = await claudeJson<{ guidance: string; summary: string }>(env, LEARN_SYSTEM, user, learnSchema, { tier: 'fast', maxTokens: 1200 });
    learned = { ...base, status: 'updated', note: `Rests on ${decided.reduce((n, f) => n + f.tests, 0)} tests across ${decided.length} format${decided.length === 1 ? '' : 's'}.`, guidance: String(out.guidance ?? '').replace(/\s+/g, ' ').trim().slice(0, 900), summary: String(out.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 600) };
  }
  await setMeta(env.DB, LEARNED_KEY, JSON.stringify(learned));
  return learned;
}
