/**
 * Trial reels: the same footage with one line changed, published as Instagram trial reels (shown to non-followers
 * only, never on the profile grid) so openings and endings can be compared on real viewers.
 *
 *  1. writeTrials: the Claude API writes alternative lines for a rendered video. Each trial changes exactly one line
 *     (scene 1, the hook, or the last scene, the ending), so a difference in the numbers has one cause.
 *  2. The "Trial video" workflow (video/trials.py) re-narrates and recompiles each trial from the kept clips (no new
 *     footage is paid for) and reports the file here.
 *  3. postTrial schedules a file as a trial reel through Zernio, only when the owner said yes. Trials are never deleted.
 *  4. trialStats reads each trial's numbers back from Zernio (skip rate, watch time, shares, saves).
 *  5. The daily loop (nextTrialBatch, autoPostTrials; TRIALS_AUTO=true): every morning the workflow asks for
 *     yesterday's video, renders three variations and schedules them for the same day, on the owner's standing yes.
 *
 * The hook formats and the four ways an opening fails follow the open "hook-master" skill by Liam Johnston.
 */
import { claudeJson } from './claude';
import { MAX_SCENE_WORDS, getVideo, parseScript, type VideoEnv, type VideoScript } from './videos';
import { createPost, deletePost, getPost, listAccounts, postAnalytics, recentPublished, uploadVideo, type ZernioEnv } from './zernio';

export type TrialKind = 'hook' | 'ending';

export interface TrialRow {
  id: number;
  slug: string;
  n: number;
  kind: TrialKind;
  format: string;
  line: string;
  why: string;
  /** written (waiting for the render) | ready (file rendered, waiting for the owner's yes) | posted (scheduled or live as a trial reel) */
  status: string;
  video_url: string;
  publish_id: string;
  scheduled_for: string;
  /** The follow ending this trial is rendered with (FOLLOW_ENDINGS), or '' for none. */
  ending: string;
  created_at: string;
  updated_at: string;
}

/**
 * The follow endings (video/follow_ending.py): a few seconds after the story in which the narrator asks for a follow
 * and the picture shows the tap. "pointer" points at Instagram's own Follow button, so it only suits Instagram.
 */
export const FOLLOW_ENDINGS = ['card', 'drawn', 'pointer'] as const;

const MIN_LINE_WORDS = 16;

const TRIAL_SYSTEM = `You write alternative lines for a finished 90-second narrated explainer video about a supplement, so the owner can test which opening or ending keeps strangers watching.

The pictures are already made and cannot change. Every line you write is spoken over the existing picture of its scene, so it must fit that picture: the first thing named in an opening should be what the viewer is looking at.

An OPENING (scene 1) has two jobs: make the topic clear at once, and make the right viewer curious about something this video really answers. It fails in one of four ways: delay (the subject arrives late), confusion (it needs a second listen, or a pronoun has nothing behind it), irrelevance (it is not about the viewer's own life, body or belief), disinterest (clear but obvious, no gap between what the viewer believes and what the video shows). Find the contrast first: what the viewer believes now against what this video shows. Then write it in the requested format:
- fortune teller: what the viewer will notice or know the next time something ordinary happens to them
- experimenter: somebody in the story tried something, and the result is about to be shown
- investigator: why a familiar thing happens, posed as an open case
- contrarian: a common belief stated plainly and refused
- teacher: a plain promise of what the next ninety seconds explain
- cold fact: the single strangest true fact of the story, said flat, with no set-up
The opening must lead straight into scene 2 as it is already written.

An ENDING (the last scene) follows the second-to-last scene as written and lands the payoff. Requested formats:
- question: leaves the viewer one honest question about their own habit
- mirror: turns the story onto the viewer's own day in one concrete picture
- full circle: lands the opening image with its new meaning, without announcing the return
- quiet fact: ends on the smallest true detail that changes how the whole story reads
- share line: a closing thought someone would send to one particular person in their life (never ask for the share)

Rules that never bend:
- Only facts that are already in the script, at their true size. No new numbers, studies, names, dates or quotes.
- No doses, no health promises, no advice, no warnings. The video tells a story.
- No call to follow, like, comment, share or visit anything. No website, no brand, no "link in bio".
- Each line is ${MIN_LINE_WORDS} to ${MAX_SCENE_WORDS} spoken words: it must fill about nine seconds and not run over.
- Plain spoken English, short sentences, digits written the way a narrator says them. No dashes, no emoji, no stage directions.
- Never use: "is not just", "You think", "Watch the", "Look at", "Here is", "Back to", "Remember", "Most people think", "Nobody tells you", "turns out", "the truth is", "plot twist", "little did", "What if I told you".
- Each line must differ from the original line and from the other lines in its grammatical move and its first two words.`;

const trialsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    trials: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['hook', 'ending'] },
          format: { type: 'string', description: 'The requested format, in its listed name.' },
          line: { type: 'string', description: `The spoken line that replaces the original, ${MIN_LINE_WORDS} to ${MAX_SCENE_WORDS} words.` },
          why: { type: 'string', description: 'One short sentence for the owner: the contrast this line uses.' },
        },
        required: ['kind', 'format', 'line', 'why'],
      },
    },
  },
  required: ['trials'],
};

function wordsIn(text: string): number {
  return text.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

const HOOK_FORMATS = ['investigator', 'cold fact', 'contrarian', 'fortune teller', 'experimenter', 'teacher'];
const ENDING_FORMATS = ['mirror', 'question', 'quiet fact', 'full circle', 'share line'];

/** The plan for a batch: which line each trial changes and in which format, rotating so later batches try new formats. */
export function trialPlan(hooks: number, endings: number, already: TrialRow[]): { kind: TrialKind; format: string }[] {
  const used = (kind: TrialKind) => new Set(already.filter((r) => r.kind === kind).map((r) => r.format));
  const pick = (kind: TrialKind, pool: string[], count: number) => {
    const fresh = pool.filter((f) => !used(kind).has(f));
    const order = [...fresh, ...pool.filter((f) => !fresh.includes(f))];
    return Array.from({ length: count }, (_, i) => ({ kind, format: order[i % order.length] }));
  };
  return [...pick('hook', HOOK_FORMATS, hooks), ...pick('ending', ENDING_FORMATS, endings)];
}

export async function listTrials(db: D1Database, slug?: string): Promise<TrialRow[]> {
  const q = slug
    ? db.prepare('SELECT * FROM video_trials WHERE slug = ? ORDER BY n').bind(slug)
    : db.prepare('SELECT * FROM video_trials ORDER BY id DESC LIMIT 200');
  return (await q.all<TrialRow>()).results ?? [];
}

export async function getTrial(db: D1Database, slug: string, n: number): Promise<TrialRow | null> {
  return db.prepare('SELECT * FROM video_trials WHERE slug = ? AND n = ?').bind(slug, n).first<TrialRow>();
}

/** Ask the Claude API for a batch of one-line trials of a rendered video and store them as "written". */
export async function writeTrials(env: VideoEnv, slug: string, hooks = 2, endings = 1): Promise<{ ok: true; trials: TrialRow[] } | { ok: false; message: string }> {
  const video = await getVideo(env.DB, slug);
  const script = video ? parseScript(video.script_json) : null;
  if (!video || !script) return { ok: false, message: `no video script for "${slug}"` };
  if (!video.video_url) return { ok: false, message: `"${slug}" has not been rendered yet; trials reuse its footage` };
  const already = await listTrials(env.DB, slug);
  const plan = trialPlan(Math.min(4, Math.max(0, hooks)), Math.min(4, Math.max(0, endings)), already);
  if (!plan.length) return { ok: false, message: 'nothing asked for' };
  const last = script.scenes.length;
  const user = [
    `Video: ${script.title}`,
    '',
    'The script as rendered (narration | picture):',
    ...script.scenes.map((s, i) => `${i + 1}. ${s.narration} | ${s.visual}`),
    '',
    already.length ? `Lines already tried, do not repeat their move:\n${already.map((r) => `- (${r.kind}) ${r.line}`).join('\n')}\n` : '',
    `Write exactly ${plan.length} trials, in this order:`,
    ...plan.map((p, i) => `${i + 1}. ${p.kind === 'hook' ? `a new OPENING for scene 1, format: ${p.format}` : `a new ENDING for scene ${last}, format: ${p.format}`}`),
  ].join('\n');
  const out = await claudeJson<{ trials: { kind: TrialKind; format: string; line: string; why: string }[] }>(env, TRIAL_SYSTEM, user, trialsSchema, { tier: 'fast', maxTokens: 3000 });
  const lines = (out.trials ?? []).slice(0, plan.length).map((t, i) => ({ kind: plan[i].kind, format: plan[i].format, line: String(t.line ?? '').replace(/\s+/g, ' ').replace(/[–—]/g, ',').trim(), why: String(t.why ?? '').trim().slice(0, 300) }));
  const bad = lines.find((t) => wordsIn(t.line) > MAX_SCENE_WORDS || wordsIn(t.line) < 8);
  if (lines.length !== plan.length || bad) return { ok: false, message: bad ? `a line has ${wordsIn(bad.line)} words (limit ${MAX_SCENE_WORDS}); ask again` : 'the model returned too few lines; ask again' };
  let n = already.reduce((m, r) => Math.max(m, r.n), 0);
  for (const t of lines) {
    n += 1;
    await env.DB.prepare("INSERT INTO video_trials (slug, n, kind, format, line, why, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'written', datetime('now'), datetime('now'))")
      .bind(slug, n, t.kind, t.format, t.line, t.why).run();
  }
  return { ok: true, trials: (await listTrials(env.DB, slug)).slice(-lines.length) };
}

/** The render job for one trial: the original script with the one line swapped; the file is named <slug>-t<n>. */
export function trialJob(script: VideoScript, caption: string, row: TrialRow): { slug: string; title: string; script: VideoScript; caption: string; ending: string } {
  const at = row.kind === 'hook' ? 0 : script.scenes.length - 1;
  const scenes = script.scenes.map((s, i) => (i === at ? { ...s, narration: row.line } : s));
  return { slug: `${row.slug}-t${row.n}`, title: script.title, script: { ...script, scenes }, caption, ending: row.ending ?? '' };
}

/**
 * Give every waiting trial of a video its follow ending. The three trials of a batch get the three endings, and the
 * order moves on by one with every batch, so over time each ending meets each trial slot equally often and neither
 * comparison (the lines, the endings) leans on the other.
 */
async function assignEndings(db: D1Database, slug: string): Promise<void> {
  const waiting = (await listTrials(db, slug)).filter((r) => r.status === 'written' && !r.ending);
  if (!waiting.length) return;
  const batches = (await db.prepare("SELECT COUNT(DISTINCT slug) AS c FROM video_trials WHERE ending != '' AND slug != ?").bind(slug).first<{ c: number }>())?.c ?? 0;
  for (const r of waiting) {
    const ending = FOLLOW_ENDINGS[(batches + r.n - 1) % FOLLOW_ENDINGS.length];
    await db.prepare("UPDATE video_trials SET ending = ?, updated_at = datetime('now') WHERE id = ?").bind(ending, r.id).run();
  }
}

/** What the workflow renders next for a slug: every trial still "written", as ready-made render jobs. */
export async function trialJobs(env: VideoEnv, slug: string): Promise<{ n: number; job: ReturnType<typeof trialJob> }[]> {
  const video = await getVideo(env.DB, slug);
  const script = video ? parseScript(video.script_json) : null;
  if (!video || !script) return [];
  await assignEndings(env.DB, slug);
  return (await listTrials(env.DB, slug)).filter((r) => r.status === 'written').map((r) => ({ n: r.n, job: trialJob(script, video.caption, r) }));
}

export async function markTrialReady(db: D1Database, slug: string, n: number, videoUrl: string): Promise<boolean> {
  const r = await db.prepare("UPDATE video_trials SET status = 'ready', video_url = ?, updated_at = datetime('now') WHERE slug = ? AND n = ? AND status IN ('written', 'ready')").bind(videoUrl, slug, n).run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Schedule one rendered trial on Instagram. mode "trial": a real trial reel (non-followers only, graduates only by
 * hand), which Instagram allows from 1,000 followers. mode "reels_tab": an ordinary reel kept out of the feed and the
 * main grid (it shows under the profile's Reels tab), the nearest thing below that follower count.
 */
export async function postTrial(env: VideoEnv, slug: string, n: number, when: string, mode: 'trial' | 'reels_tab' = 'trial'): Promise<{ ok: true; id: string; when: string } | { ok: false; message: string }> {
  const row = await getTrial(env.DB, slug, n);
  if (!row || !row.video_url) return { ok: false, message: 'no rendered trial with that number' };
  if (row.status === 'posted') return { ok: false, message: `already scheduled (${row.publish_id})` };
  const video = await getVideo(env.DB, slug);
  if (!video) return { ok: false, message: 'the original video row is gone' };
  const z = env as ZernioEnv;
  const accounts = await listAccounts(z);
  if (!accounts.ok) return { ok: false, message: accounts.message };
  const targets = accounts.accounts.filter((a) => a.platform === 'instagram').map((a) => ({ platform: a.platform, accountId: a.id }));
  if (!targets.length) return { ok: false, message: 'no Instagram account is connected in Zernio' };
  const res = await fetch(row.video_url, { redirect: 'follow' });
  if (!res.ok) return { ok: false, message: `fetching the rendered file failed: HTTP ${res.status}` };
  const up = await uploadVideo(z, await res.arrayBuffer(), `${slug}-t${n}-${Date.now()}.mp4`);
  if (!up.ok) return up;
  const post = await createPost(z, { content: video.caption, mediaUrl: up.url, targets, madeWithAi: true, title: parseScript(video.script_json)?.title, scheduledFor: when, timezone: 'Europe/Madrid', ...(mode === 'trial' ? { trial: 'MANUAL' as const } : { shareToFeed: false }) });
  if (!post.ok) return post;
  await env.DB.prepare("UPDATE video_trials SET status = 'posted', publish_id = ?, scheduled_for = ?, updated_at = datetime('now') WHERE id = ?").bind(post.id, when, row.id).run();
  return { ok: true, id: post.id, when };
}

export interface TrialStat {
  slug: string;
  n: number;
  kind: string;
  format: string;
  line: string;
  /** The follow ending the trial carries, or '' for none. */
  ending: string;
  scheduled_for: string;
  views: number | null;
  reach: number | null;
  skip_rate: number | null;
  avg_watch_seconds: number | null;
  likes: number | null;
  shares: number | null;
  saves: number | null;
  comments: number | null;
  follows: number | null;
  note?: string;
}

/** Every posted trial with its numbers from Zernio's analytics (empty until Instagram has reported them). */
export async function trialStats(env: VideoEnv, slug?: string): Promise<TrialStat[]> {
  const rows = (await listTrials(env.DB, slug)).filter((r) => r.status === 'posted' && r.publish_id);
  const out: TrialStat[] = [];
  for (const r of rows.slice(0, 40)) {
    const a = await postAnalytics(env as ZernioEnv, r.publish_id);
    const m = a.ok ? a.metrics : {};
    const num = (k: string) => (typeof m[k] === 'number' ? (m[k] as number) : null);
    const watch = num('igReelsAvgWatchTime');
    out.push({
      slug: r.slug, n: r.n, kind: r.kind, format: r.format, line: r.line, ending: r.ending ?? '', scheduled_for: r.scheduled_for,
      views: num('views'), reach: num('reach'), skip_rate: num('reelsSkipRate'), avg_watch_seconds: watch === null ? null : Math.round(watch / 100) / 10,
      likes: num('likes'), shares: num('shares'), saves: num('saves'), comments: num('comments'), follows: num('follows'),
      ...(a.ok ? {} : { note: a.message }),
    });
  }
  return out.sort((x, y) => (x.slug === y.slug ? x.n - y.n : x.slug < y.slug ? -1 : 1));
}

/**
 * Put a trial back to "ready" when its post never went out (still scheduled, or refused by Instagram), removing the
 * unpublished post from Zernio. A trial that was published is never touched: published trials are kept.
 */
export async function resetTrial(env: VideoEnv, slug: string, n: number): Promise<{ ok: true } | { ok: false; message: string }> {
  const row = await getTrial(env.DB, slug, n);
  if (!row || row.status !== 'posted') return { ok: false, message: 'no scheduled trial with that number' };
  const z = env as ZernioEnv;
  const post = await getPost(z, row.publish_id);
  const p = post.ok ? (((post.post as { post?: unknown }).post ?? post.post) as { status?: string; platforms?: { status?: string }[] }) : null;
  if (!p) return { ok: false, message: post.ok ? 'could not read the post' : post.message };
  if (p.status === 'published' || (p.platforms ?? []).some((x) => x.status === 'published')) return { ok: false, message: 'this trial was published; published trials are kept' };
  const gone = await deletePost(z, row.publish_id);
  if (!gone.ok && !/404/.test(gone.message)) return gone;
  await env.DB.prepare("UPDATE video_trials SET status = 'ready', publish_id = '', scheduled_for = '', updated_at = datetime('now') WHERE id = ?").bind(row.id).run();
  return { ok: true };
}

// ---- The daily loop ----

const madridDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const madridClock = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
/** Batches rotate through these hours (Madrid), so the time of day is tested between batches while a batch shares one hour. */
const TRIAL_HOURS = ['13:00', '18:00', '21:00'];

type TrialAutoEnv = VideoEnv & { TRIALS_AUTO?: string; TRIALS_SKIP?: string };

/**
 * What the morning workflow should render: the video that was published yesterday (Madrid time), with a fresh batch
 * of two openings and one ending written by the Claude API unless that video already has trials.
 */
export async function nextTrialBatch(env: TrialAutoEnv): Promise<{ slug: string | null; reason: string; jobs: { n: number; job: ReturnType<typeof trialJob> }[] }> {
  if (env.TRIALS_AUTO !== 'true') return { slug: null, reason: 'TRIALS_AUTO is not "true"', jobs: [] };
  const yesterday = madridDay(new Date(Date.now() - 24 * 3600_000));
  const published = (await recentPublished(env as ZernioEnv, 20)).filter((p) => p.video && p.at && madridDay(new Date(p.at)) === yesterday);
  let slug = '';
  for (const p of published) {
    const row = await env.DB.prepare('SELECT slug FROM videos WHERE publish_id = ?').bind(`zernio:${p.id}`).first<{ slug: string }>();
    if (row) { slug = row.slug; break; }
  }
  if (!slug) return { slug: null, reason: `no video of ours was published on ${yesterday}`, jobs: [] };
  if ((env.TRIALS_SKIP ?? '').split(',').map((s) => s.trim()).includes(slug)) return { slug, reason: 'this video is on the skip list (its raw clips are not clean)', jobs: [] };
  const existing = await listTrials(env.DB, slug);
  if (!existing.length) {
    const written = await writeTrials(env, slug, 2, 1);
    if (!written.ok) return { slug, reason: `writing failed: ${written.message}`, jobs: [] };
  }
  const jobs = await trialJobs(env, slug);
  return { slug, reason: jobs.length ? 'render these' : 'this video already has its trials', jobs };
}

/** Schedule every rendered ("ready") trial of a video for today, two minutes apart, in this batch's hour. */
export async function autoPostTrials(env: TrialAutoEnv, slug: string): Promise<{ ok: boolean; posted: { n: number; when: string }[]; errors: string[] }> {
  if (env.TRIALS_AUTO !== 'true') return { ok: false, posted: [], errors: ['TRIALS_AUTO is not "true"'] };
  const ready = (await listTrials(env.DB, slug)).filter((r) => r.status === 'ready');
  if (!ready.length) return { ok: false, posted: [], errors: ['nothing rendered is waiting'] };
  const batches = (await env.DB.prepare("SELECT COUNT(DISTINCT slug || substr(scheduled_for, 1, 10)) AS c FROM video_trials WHERE status = 'posted'").first<{ c: number }>())?.c ?? 0;
  const now = new Date();
  const soon = madridClock(new Date(now.getTime() + 15 * 60_000));
  const wanted = TRIAL_HOURS[batches % TRIAL_HOURS.length];
  // An hour that has already passed today falls back to a quarter of an hour from now.
  const [h, m] = (wanted > soon ? wanted : soon).split(':').map(Number);
  const posted: { n: number; when: string }[] = [];
  const errors: string[] = [];
  for (const [i, r] of ready.entries()) {
    const minutes = h * 60 + m + i * 2;
    const when = `${madridDay(now)}T${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
    const res = await postTrial(env, slug, r.n, when, 'reels_tab');
    if (res.ok) posted.push({ n: r.n, when });
    else errors.push(`trial ${r.n}: ${res.message}`);
  }
  return { ok: !errors.length, posted, errors };
}
