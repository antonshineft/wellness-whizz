/**
 * What the quiz data says: the recommendations the advisor made, aggregated by goal, age, sex, activity and diet, for
 * the owner's dashboard (/api/admin/quizdata) and for the data article the pipeline can draft from it (&draft=1).
 * Only ready sessions count; goals and diets are free text, so they are sorted into themes by keyword.
 */
import { asKind } from './articles';
import type { ArticleEnv } from './articles';
import { enqueueArticle } from './articles';

export interface Count {
  name: string;
  count: number;
  pct: number;
}

export interface QuizDataSummary {
  generated_at: string;
  sessions: number;
  first_session: string | null;
  last_session: string | null;
  by_sex: Count[];
  by_age: Count[];
  by_activity: Count[];
  goal_themes: Count[];
  diet_tags: Count[];
  top_supplements: Count[];
  first_pick: Count[];
  top_by_theme: Record<string, Count[]>;
  top_by_age: Record<string, Count[]>;
  top_by_sex: Record<string, Count[]>;
  top_by_diet: Record<string, Count[]>;
}

const THEMES: [theme: string, re: RegExp][] = [
  ['sleep', /sleep|insomnia|dormir|sueño|descans/i],
  ['energy', /energy|fatigue|tired|energ[ií]a|cansan/i],
  ['stress and anxiety', /stress|anxiet|anxious|calm|estr[eé]s|ansiedad|relax/i],
  ['focus and memory', /focus|memory|concentrat|brain|cognit|concentraci|memoria/i],
  ['immune support', /immun|inmun|cold|flu/i],
  ['muscle and performance', /muscle|strength|gym|workout|training|recovery|athlet|performance|m[uú]sculo|fuerza|entren/i],
  ['joint health', /joint|arthritis|articulac|cartilage/i],
  ['gut health', /gut|digest|bloat|ibs|intestin|stomach/i],
  ['heart health', /heart|cholesterol|blood pressure|cardio|coraz[oó]n|colesterol/i],
  ['weight management', /weight|fat loss|slim|peso|adelgaz/i],
  ['skin, hair and nails', /skin|hair|nail|piel|cabello|uñas/i],
  ['hormonal balance', /hormon|testosterone|menopaus|pcos|libido|fertil|thyroid|tiroid/i],
  ['healthy ageing', /aging|ageing|longevity|envejec|longevidad/i],
  ['mood', /mood|depress|[aá]nimo/i],
  ['bone health', /bone|osteop|hueso/i],
];

const DIETS: [tag: string, re: RegExp][] = [
  ['vegan', /vegan|vegano|vegana/i],
  ['vegetarian', /vegetarian|vegetarian[oa]/i],
  ['gluten-free', /gluten/i],
  ['dairy-free', /dairy|lactose|l[aá]cteo|lactosa/i],
  ['keto or low-carb', /keto|low[- ]carb|carbohidrat/i],
  ['halal or kosher', /halal|kosher/i],
  ['pescatarian', /pescatarian|pescetarian/i],
  ['paleo', /paleo/i],
  ['no restrictions', /^(none|no|n\/a|nothing|no restrictions?|regular|normal|standard|balanced|omnivore|everything|mixed|-|sin restricciones|ninguna)$/i],
];

function counts(map: Map<string, number>, total: number, limit = 50): Count[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count, pct: total ? Math.round((1000 * count) / total) / 10 : 0 }));
}

function bump(map: Map<string, number>, key: string, n = 1): void {
  map.set(key, (map.get(key) ?? 0) + n);
}

export async function quizDataSummary(db: D1Database): Promise<QuizDataSummary> {
  const sessions = (
    await db.prepare("SELECT id, sex, age, activity, diet, goal, created_at FROM sessions WHERE status = 'ready'").all<{ id: string; sex: string; age: string; activity: string; diet: string; goal: string; created_at: string }>()
  ).results;
  const picks = (
    await db
      .prepare('SELECT ss.session_id, ss.position, s.name FROM session_supplements ss JOIN supplements s ON s.id = ss.supplement_id')
      .all<{ session_id: string; position: number; name: string }>()
  ).results;
  const total = sessions.length;
  const bySession = new Map<string, { position: number; name: string }[]>();
  for (const p of picks) {
    const list = bySession.get(p.session_id) ?? [];
    list.push({ position: p.position, name: p.name });
    bySession.set(p.session_id, list);
  }

  const sex = new Map<string, number>();
  const age = new Map<string, number>();
  const activity = new Map<string, number>();
  const themes = new Map<string, number>();
  const diets = new Map<string, number>();
  const supplements = new Map<string, number>();
  const first = new Map<string, number>();
  const byTheme = new Map<string, Map<string, number>>();
  const byAge = new Map<string, Map<string, number>>();
  const bySex = new Map<string, Map<string, number>>();
  const byDiet = new Map<string, Map<string, number>>();
  const nested = (outer: Map<string, Map<string, number>>, key: string) => {
    const inner = outer.get(key) ?? new Map<string, number>();
    outer.set(key, inner);
    return inner;
  };
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const s of sessions) {
    if (!firstAt || s.created_at < firstAt) firstAt = s.created_at;
    if (!lastAt || s.created_at > lastAt) lastAt = s.created_at;
    const list = bySession.get(s.id) ?? [];
    const names = [...new Set(list.map((p) => p.name))];
    if (s.sex) bump(sex, s.sex);
    if (s.age) bump(age, s.age);
    if (s.activity) bump(activity, s.activity);
    const sessionThemes = THEMES.filter(([, re]) => re.test(s.goal ?? '')).map(([t]) => t);
    for (const t of sessionThemes) bump(themes, t);
    const sessionDiets = DIETS.filter(([, re]) => re.test((s.diet ?? '').trim())).map(([t]) => t);
    for (const d of sessionDiets) bump(diets, d);
    for (const n of names) {
      bump(supplements, n);
      for (const t of sessionThemes) bump(nested(byTheme, t), n);
      if (s.age) bump(nested(byAge, s.age), n);
      if (s.sex) bump(nested(bySex, s.sex), n);
      for (const d of sessionDiets) bump(nested(byDiet, d), n);
    }
    const top = list.find((p) => p.position === 1) ?? list[0];
    if (top) bump(first, top.name);
  }
  const nestedCounts = (outer: Map<string, Map<string, number>>, totals: Map<string, number>, limit = 8): Record<string, Count[]> =>
    Object.fromEntries([...outer.entries()].filter(([k]) => (totals.get(k) ?? 0) >= 5).map(([k, inner]) => [k, counts(inner, totals.get(k) ?? 0, limit)]));

  return {
    generated_at: new Date().toISOString(),
    sessions: total,
    first_session: firstAt,
    last_session: lastAt,
    by_sex: counts(sex, total),
    by_age: counts(age, total),
    by_activity: counts(activity, total),
    goal_themes: counts(themes, total),
    diet_tags: counts(diets, total),
    top_supplements: counts(supplements, total, 25),
    first_pick: counts(first, total, 10),
    top_by_theme: nestedCounts(byTheme, themes),
    top_by_age: nestedCounts(byAge, age),
    top_by_sex: nestedCounts(bySex, sex),
    top_by_diet: nestedCounts(byDiet, diets),
  };
}

/** A compact, plain-text brief of the numbers for the article writer: it must use these and nothing else. */
export function quizDataBrief(d: QuizDataSummary): string {
  const line = (items: Count[], n = 10) => items.slice(0, n).map((c) => `${c.name} ${c.pct}% (${c.count})`).join('; ');
  const nested = (rec: Record<string, Count[]>, n = 5) =>
    Object.entries(rec)
      .map(([k, v]) => `  - ${k}: ${v.slice(0, n).map((c) => `${c.name} ${c.pct}%`).join(', ')}`)
      .join('\n');
  const month = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return [
    `DATA BRIEF (Wellness Whizz quiz, ${d.sessions} completed plans from ${d.first_session?.slice(0, 10) ?? '?'} to ${d.last_session?.slice(0, 10) ?? '?'}, compiled ${month}). Every plan is 3 to 5 supplements the AI advisor recommended for one person's quiz answers. Percentages are the share of plans. Not a representative sample of the population: quiz takers are people who went looking for supplement advice.`,
    `Who took it: sex ${line(d.by_sex)}; age ${line(d.by_age)}; activity ${line(d.by_activity)}.`,
    `Goals mentioned (a plan can mention several): ${line(d.goal_themes, 15)}.`,
    `Diets mentioned: ${line(d.diet_tags)}.`,
    `Most recommended supplements overall: ${line(d.top_supplements, 15)}.`,
    `Most often the first pick: ${line(d.first_pick, 6)}.`,
    `Top picks by goal:\n${nested(d.top_by_theme)}`,
    `Top picks by age group:\n${nested(d.top_by_age)}`,
    `Top picks by sex:\n${nested(d.top_by_sex)}`,
    `Top picks by diet:\n${nested(d.top_by_diet)}`,
    'RULES: use only the numbers in this brief, exactly as given (round nothing further, invent nothing, no national statistics). Name the source as "the Wellness Whizz quiz" and include a short "How we counted" section with the limitations above. Link each supplement named to its catalogue page. Do not claim the numbers show what works, only what the advisor recommended for the people who asked.',
  ].join('\n');
}

/** Queue the data article; the owner reviews and publishes it from the usual email. */
export async function queueQuizDataArticle(env: ArticleEnv): Promise<{ slug: string; sessions: number }> {
  const summary = await quizDataSummary(env.DB);
  const month = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const slug = `what-${summary.sessions}-supplement-plans-say-${month.toLowerCase().replace(/\s+/g, '-')}`;
  const topic = `What ${summary.sessions} supplement plans say: the supplements the Wellness Whizz advisor recommends most, by goal, age, sex and diet (${month} data report)`;
  await enqueueArticle(env, { topic, kind: asKind('guide', 'guide'), slug, notes: quizDataBrief(summary) });
  return { slug, sessions: summary.sessions };
}
