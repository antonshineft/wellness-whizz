/**
 * The trial-reel dashboard: every test (one video, its trial reels and the original post) with the numbers Zernio
 * reports, a retention chart and a plain-words review. The daily cron stores a snapshot per post (snapshotTrials), so
 * the page loads from the database and shows what changed since yesterday; "Refresh" takes a new snapshot on demand.
 * The page is opened through its own unguessable link, so the admin key never travels in a URL.
 */
import { getMeta, setMeta } from './db';
import { escapeHtml } from './html';
import { listTrials, type TrialRow } from './trials';
import { getVideo, parseScript, type VideoEnv } from './videos';
import { postAnalyticsRaw, type ZernioEnv } from './zernio';

interface Snapshot {
  status: string;
  error: string;
  url: string;
  published_at: string;
  views: number | null;
  reach: number | null;
  skip_rate: number | null;
  avg_watch: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  follows: number | null;
  duration: number | null;
  retention: [number, number][];
}

function pick(raw: Record<string, unknown>): Snapshot {
  const list = Array.isArray(raw.platformAnalytics) ? (raw.platformAnalytics as Record<string, unknown>[]) : [];
  const ig = list.find((p) => p.platform === 'instagram');
  const a = ((ig?.analytics ?? (list.length ? null : raw.analytics)) ?? {}) as Record<string, unknown>;
  const num = (k: string) => (typeof a[k] === 'number' && Number.isFinite(a[k] as number) ? (a[k] as number) : null);
  const curve = (a.retentionCurve ?? {}) as Record<string, unknown>;
  const retention = Object.entries(curve)
    .map(([t, v]) => [Number(t), Number(v)] as [number, number])
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
    .sort((x, y) => x[0] - y[0]);
  const watch = num('igReelsAvgWatchTime');
  return {
    status: String(ig?.status ?? raw.status ?? ''),
    error: String(ig?.errorMessage ?? '') === 'null' ? '' : String(ig?.errorMessage ?? ''),
    url: String(ig?.platformPostUrl ?? ''),
    published_at: String(raw.publishedAt ?? ''),
    views: num('views'), reach: num('reach'), skip_rate: num('reelsSkipRate'), avg_watch: watch === null ? null : watch / 1000,
    likes: num('likes'), comments: num('comments'), shares: num('shares'), saves: num('saves'), follows: num('follows'),
    duration: num('videoDurationSeconds'), retention,
  };
}

/** Store today's numbers for every posted trial and for the original post of each tested video. */
export async function snapshotTrials(env: VideoEnv): Promise<{ stored: number; failed: number }> {
  const trials = (await listTrials(env.DB)).filter((r) => r.status === 'posted' && r.publish_id);
  const refs: { ref: string; id: string }[] = trials.map((r) => ({ ref: `trial:${r.id}`, id: r.publish_id }));
  for (const slug of [...new Set(trials.map((r) => r.slug))]) {
    const id = ((await getVideo(env.DB, slug))?.publish_id ?? '').replace(/^zernio:/, '');
    if (/^[0-9a-f]{24}$/.test(id)) refs.push({ ref: `video:${slug}`, id });
  }
  const day = new Date().toISOString().slice(0, 10);
  let stored = 0;
  let failed = 0;
  for (const r of refs.slice(0, 80)) {
    const a = await postAnalyticsRaw(env as ZernioEnv, r.id);
    if (!a.ok) { failed += 1; continue; }
    await env.DB.prepare("INSERT INTO video_trial_stats (ref, day, json, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT (ref, day) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at")
      .bind(r.ref, day, JSON.stringify(pick(a.data))).run();
    stored += 1;
  }
  await setMeta(env.DB, 'trials:snapshot', new Date().toISOString());
  return { stored, failed };
}

/** The dashboard's own link token (created on first use). */
export async function dashboardToken(db: D1Database): Promise<string> {
  let token = await getMeta(db, 'trials:dashboard_token');
  if (!token) {
    token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    await setMeta(db, 'trials:dashboard_token', token);
  }
  return token;
}

interface Series { key: string; label: string; tag: string; line: string; kind: string; format: string; now: Snapshot | null; before: Snapshot | null; slot: number; file: string; when: string }

async function latestTwo(db: D1Database, ref: string): Promise<[Snapshot | null, Snapshot | null]> {
  const rows = (await db.prepare('SELECT json FROM video_trial_stats WHERE ref = ? ORDER BY day DESC LIMIT 2').bind(ref).all<{ json: string }>()).results ?? [];
  const parse = (s?: string) => { try { return s ? (JSON.parse(s) as Snapshot) : null; } catch { return null; } };
  return [parse(rows[0]?.json), parse(rows[1]?.json)];
}

const fmt = (n: number | null, digits = 0) => (n === null ? '–' : n.toLocaleString('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const per1k = (n: number | null, views: number | null) => (n === null || !views ? null : (n / views) * 1000);
const MIN_VIEWS = 300;

/** A plain-words reading of one test. Deliberately cautious: small view counts decide nothing. */
function review(series: Series[]): string[] {
  const trials = series.filter((s) => s.key !== 'orig');
  const live = trials.filter((s) => s.now && s.now.views !== null);
  if (!live.length) return ['No numbers yet. Instagram usually reports the first figures a few hours after a reel goes out.'];
  const out: string[] = [];
  const thin = live.filter((s) => (s.now?.views ?? 0) < MIN_VIEWS);
  if (thin.length) out.push(`Too early to call: ${thin.map((s) => s.tag).join(', ')} ${thin.length === 1 ? 'has' : 'have'} fewer than ${MIN_VIEWS} views. Treat everything below as a first look.`);
  const withSkip = series.filter((s) => s.now?.skip_rate !== null && s.now?.skip_rate !== undefined && (s.key === 'orig' || s.kind === 'hook'));
  if (withSkip.length >= 2) {
    const sorted = [...withSkip].sort((a, b) => (a.now!.skip_rate as number) - (b.now!.skip_rate as number));
    const [best, next] = sorted;
    const gap = (next.now!.skip_rate as number) - (best.now!.skip_rate as number);
    out.push(gap < 3
      ? `Openings: no clear winner. ${best.tag} loses ${fmt(best.now!.skip_rate, 1)}% of viewers in the first three seconds and ${next.tag} ${fmt(next.now!.skip_rate, 1)}%, which is too close to separate.`
      : `Openings: ${best.tag} holds best. It loses ${fmt(best.now!.skip_rate, 1)}% of viewers in the first three seconds, ${fmt(gap, 1)} points fewer than ${next.tag}.`);
  }
  const enders = series.filter((s) => s.now?.avg_watch !== null && s.now?.avg_watch !== undefined && (s.key === 'orig' || s.kind === 'ending'));
  if (enders.some((s) => s.kind === 'ending') && enders.length >= 2) {
    const bestWatch = [...enders].sort((a, b) => (b.now!.avg_watch as number) - (a.now!.avg_watch as number))[0];
    const shares = [...enders].filter((s) => per1k(s.now!.shares, s.now!.views) !== null).sort((a, b) => (per1k(b.now!.shares, b.now!.views) as number) - (per1k(a.now!.shares, a.now!.views) as number))[0];
    out.push(`Endings: ${bestWatch.tag} is watched longest (${fmt(bestWatch.now!.avg_watch, 1)} s on average)${shares ? `, and ${shares.tag} is shared most (${fmt(per1k(shares.now!.shares, shares.now!.views), 1)} per 1,000 views)` : ''}. An ending can only move viewers who reach it, so expect small differences.`);
  }
  const refused = trials.filter((s) => s.now?.error);
  for (const s of refused) out.push(`${s.tag} was not published: ${s.now!.error}`);
  return out;
}

function chart(series: Series[], id: string): string {
  const drawn = series.filter((s) => (s.now?.retention.length ?? 0) > 1);
  if (!drawn.length) return '';
  const W = 640, H = 260, L = 40, R = 46, T = 12, B = 30;
  const maxT = Math.max(...drawn.map((s) => s.now!.retention[s.now!.retention.length - 1][0]), 10);
  const x = (t: number) => L + (t / maxT) * (W - L - R);
  const y = (v: number) => T + (1 - Math.min(1, Math.max(0, v))) * (H - T - B);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? 'axis' : 'grid'}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="tick">${v * 100}%</text>`).join('');
  const step = maxT > 60 ? 20 : 10;
  const ticks = Array.from({ length: Math.floor(maxT / step) + 1 }, (_, i) => i * step).map((t) => `<text x="${x(t)}" y="${H - 8}" text-anchor="middle" class="tick">${t}s</text>`).join('');
  // End labels, nudged apart so they never overlap.
  const ends = drawn.map((s) => ({ s, y: y(s.now!.retention[s.now!.retention.length - 1][1]), x: x(s.now!.retention[s.now!.retention.length - 1][0]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  const lines = drawn.map((s) => `<polyline fill="none" class="s${s.slot}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${s.now!.retention.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`).join('');
  const labels = ends.map((e) => `<text x="${e.x + 6}" y="${e.y + 4}" class="endlabel">${escapeHtml(e.s.tag)}</text>`).join('');
  const data = JSON.stringify({ L, R, W, T, B, H, maxT, series: drawn.map((s) => ({ tag: s.tag, slot: s.slot, pts: s.now!.retention })) }).replace(/</g, '\\u003c');
  return `<figure class="chart" data-chart='${escapeHtml(data)}' id="${id}">
<figcaption>Share of viewers still watching, second by second</figcaption>
<div class="legend">${drawn.map((s) => `<span><i class="sw b${s.slot}"></i>${escapeHtml(s.tag)}</span>`).join('')}</div>
<div class="plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Retention curves; the same numbers are in the table above">${grid}${ticks}${lines}${labels}<line class="cross" y1="${T}" y2="${H - B}" x1="0" x2="0" visibility="hidden"/></svg><div class="tip" hidden></div></div>
</figure>`;
}

function table(series: Series[]): string {
  const cols: { head: string; value: (s: Snapshot) => number | null; digits: number; suffix: string; best: 'high' | 'low' | null }[] = [
    { head: 'Views', value: (s) => s.views, digits: 0, suffix: '', best: null },
    { head: 'Skipped in 3 s', value: (s) => s.skip_rate, digits: 1, suffix: '%', best: 'low' },
    { head: 'Avg watch', value: (s) => s.avg_watch, digits: 1, suffix: ' s', best: 'high' },
    { head: 'Shares / 1k', value: (s) => per1k(s.shares, s.views), digits: 1, suffix: '', best: 'high' },
    { head: 'Saves / 1k', value: (s) => per1k(s.saves, s.views), digits: 1, suffix: '', best: 'high' },
    { head: 'Likes / 1k', value: (s) => per1k(s.likes, s.views), digits: 1, suffix: '', best: 'high' },
    { head: 'Follows', value: (s) => s.follows, digits: 0, suffix: '', best: 'high' },
  ];
  const best = cols.map((c) => {
    if (!c.best) return null;
    const vals = series.map((s) => (s.now ? c.value(s.now) : null)).filter((v): v is number => v !== null);
    return vals.length >= 2 ? (c.best === 'low' ? Math.min(...vals) : Math.max(...vals)) : null;
  });
  const rows = series.map((s) => {
    const delta = s.now?.views !== null && s.now?.views !== undefined && s.before?.views !== null && s.before?.views !== undefined ? s.now.views - s.before.views : null;
    const cells = cols.map((c, i) => {
      const v = s.now ? c.value(s.now) : null;
      const top = v !== null && best[i] !== null && v === best[i];
      const extra = i === 0 && delta ? `<small>+${fmt(delta)} since the last daily check</small>` : '';
      return `<td class="num${top ? ' top' : ''}" data-label="${c.head}">${v === null ? '–' : `${fmt(v, c.digits)}${c.suffix}`}${top ? ' <span class="star" title="best in this test">★</span>' : ''}${extra}</td>`;
    }).join('');
    const links = [s.now?.url ? `<a href="${escapeHtml(s.now.url)}">on Instagram</a>` : '', s.file ? `<a href="${escapeHtml(s.file)}">file</a>` : ''].filter(Boolean).join(' · ');
    return `<tr><th scope="row"><span class="who"><i class="sw b${s.slot}"></i><b>${escapeHtml(s.tag)}</b> <em>${escapeHtml(s.label)}</em></span><span class="line">${escapeHtml(s.line)}</span><span class="meta">${escapeHtml(s.when)}${links ? ` · ${links}` : ''}</span></th>${cells}</tr>`;
  }).join('');
  return `<div class="scroll"><table><thead><tr><th scope="col">Version</th>${cols.map((c) => `<th scope="col" class="num">${c.head}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

const madrid = (iso: string) => {
  if (!iso) return '';
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}+01:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export async function trialDashboard(env: VideoEnv, token: string): Promise<string> {
  const all = await listTrials(env.DB);
  const posted = all.filter((r) => r.status === 'posted');
  const waiting = all.filter((r) => r.status !== 'posted');
  const groups = new Map<string, TrialRow[]>();
  for (const r of posted) {
    const key = `${r.slug}|${r.scheduled_for.slice(0, 10)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const cards: string[] = [];
  let index = 0;
  for (const [key, rows] of [...groups.entries()].sort((a, b) => (a[0].split('|')[1] < b[0].split('|')[1] ? 1 : -1))) {
    const slug = key.split('|')[0];
    const video = await getVideo(env.DB, slug);
    const script = video ? parseScript(video.script_json) : null;
    const series: Series[] = [];
    const [origNow, origBefore] = await latestTwo(env.DB, `video:${slug}`);
    if (origNow && script) {
      series.push({ key: 'orig', label: 'the post on your feed', tag: 'Original', line: `Opens: ${script.scenes[0].narration} Ends: ${script.scenes[script.scenes.length - 1].narration}`, kind: 'orig', format: '', now: origNow, before: origBefore, slot: 1, file: video?.video_url ?? '', when: `posted ${madrid(origNow.published_at)}` });
    }
    for (const [i, r] of rows.sort((a, b) => a.n - b.n).slice(0, 3).entries()) {
      const [now, before] = await latestTwo(env.DB, `trial:${r.id}`);
      series.push({ key: `t${r.n}`, label: `new ${r.kind === 'hook' ? 'opening' : 'ending'} (${r.format})`, tag: `Trial ${r.n}`, line: r.line, kind: r.kind, format: r.format, now, before, slot: i + 2, file: r.video_url, when: `${now?.status === 'published' ? 'posted' : 'scheduled'} ${madrid(now?.published_at || r.scheduled_for)}` });
    }
    index += 1;
    cards.push(`<section class="card"><h2>${escapeHtml(script?.title ?? slug)}</h2>
<div class="review"><h3>Review</h3><ul>${review(series).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul></div>
${table(series)}
${chart(series, `c${index}`)}</section>`);
  }
  const last = await getMeta(env.DB, 'trials:snapshot');
  const waitingList = waiting.length
    ? `<section class="card"><h2>Not posted yet</h2><ul class="plain">${waiting.map((r) => `<li><b>${escapeHtml(r.slug)} · trial ${r.n}</b> (${r.kind === 'hook' ? 'opening' : 'ending'}, ${escapeHtml(r.format)}; ${r.status === 'ready' ? `rendered, <a href="${escapeHtml(r.video_url)}">watch the file</a>` : 'rendering'})<span class="line">${escapeHtml(r.line)}</span></li>`).join('')}</ul></section>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Trial reels</title>
<style>
:root{--plane:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--good:#006300;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100}
@media (prefers-color-scheme:dark){:root{--plane:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--good:#0ca30c;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500}}
*{box-sizing:border-box}body{margin:0;background:var(--plane);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:20px 16px 48px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:0 0 12px}h3{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink2);margin:0 0 6px}
.sub{color:var(--ink2);margin:0 0 18px;font-size:14px}.sub a,.meta a,.plain a{color:inherit}
.card{background:var(--surface);border:1px solid var(--grid);border-radius:14px;padding:16px;margin:0 0 18px}
.review{border-left:3px solid var(--axis);padding:2px 0 2px 12px;margin:0 0 14px}.review ul{margin:0;padding-left:18px}.review li{margin:0 0 4px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:10px 8px;border-top:1px solid var(--grid);vertical-align:top;text-align:left}
thead th{border-top:0;font-size:12px;color:var(--ink2);font-weight:600;white-space:nowrap}.num{text-align:right;white-space:nowrap}td small{display:block;color:var(--muted);font-size:11px;white-space:normal}
tbody th{font-weight:400;min-width:230px}.who{display:block}.who em{color:var(--ink2);font-style:normal;font-size:13px}.line{display:block;color:var(--ink2);font-size:13px;margin-top:3px}.meta{display:block;color:var(--muted);font-size:12px;margin-top:3px}
.top{font-weight:700}.star{color:var(--good)}
.sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px}.b1{background:var(--s1)}.b2{background:var(--s2)}.b3{background:var(--s3)}.b4{background:var(--s4)}
.chart{margin:16px 0 0}.chart figcaption{font-size:13px;color:var(--ink2);margin:0 0 6px}.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;margin:0 0 4px}
.plot{position:relative}.plot svg{display:block;width:100%;height:auto;touch-action:pan-y}.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}.tick{fill:var(--muted);font-size:11px}.endlabel{fill:var(--ink2);font-size:11px}
.s1{stroke:var(--s1)}.s2{stroke:var(--s2)}.s3{stroke:var(--s3)}.s4{stroke:var(--s4)}.cross{stroke:var(--axis);stroke-width:1}
.tip{position:absolute;top:6px;pointer-events:none;background:var(--surface);border:1px solid var(--axis);border-radius:8px;padding:6px 9px;font-size:12px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.12)}.tip b{display:block;margin-bottom:2px}.tip span{display:block}
.plain{list-style:none;margin:0;padding:0}.plain li{padding:8px 0;border-top:1px solid var(--grid)}.plain li:first-child{border-top:0}
@media (max-width:640px){thead{display:none}tbody tr{display:block;border-top:1px solid var(--grid);padding:10px 0}tbody th,td{display:block;border:0;padding:2px 0}td.num{display:flex;justify-content:space-between;text-align:right;gap:12px}td.num:before{content:attr(data-label);color:var(--ink2);font-size:13px}td small{display:inline;margin-left:6px}}
</style></head><body><main>
<h1>Trial reels</h1>
<p class="sub">Each test shows one video with one line changed per trial. Numbers come from Instagram through Zernio and are stored once a day${last ? `; last update ${escapeHtml(madrid(last))}` : ''}. <a href="/api/trials/${escapeHtml(token)}?refresh=1">Refresh now</a></p>
${cards.join('\n') || '<section class="card"><p>No trial has been posted yet.</p></section>'}
${waitingList}
<p class="sub">How to read it: "Skipped in 3 s" judges the opening (lower is better). Average watch time, shares and saves judge the rest. A test needs about ${MIN_VIEWS} views per version before a difference means anything.</p>
</main>
<script>
document.querySelectorAll('.chart').forEach(function(f){var d=JSON.parse(f.dataset.chart),svg=f.querySelector('svg'),tip=f.querySelector('.tip'),cross=f.querySelector('.cross');
function move(e){var r=svg.getBoundingClientRect(),px=(e.clientX-r.left)/r.width*d.W,t=Math.max(0,Math.min(d.maxT,(px-d.L)/(d.W-d.L-d.R)*d.maxT)),h='',near=null;
d.series.forEach(function(s){var p=s.pts.reduce(function(a,b){return Math.abs(b[0]-t)<Math.abs(a[0]-t)?b:a});if(near===null)near=p[0];h+='<span><i class="sw b'+s.slot+'"></i>'+s.tag+': '+Math.round(p[1]*100)+'%</span>'});
var cx=d.L+near/d.maxT*(d.W-d.L-d.R);cross.setAttribute('x1',cx);cross.setAttribute('x2',cx);cross.setAttribute('visibility','visible');tip.innerHTML='<b>'+near+' s</b>'+h;tip.hidden=false;
var left=cx/d.W*r.width+10;if(left+tip.offsetWidth>r.width)left=cx/d.W*r.width-tip.offsetWidth-10;tip.style.left=Math.max(0,left)+'px'}
svg.addEventListener('pointermove',move);svg.addEventListener('pointerdown',move);svg.addEventListener('pointerleave',function(){tip.hidden=true;cross.setAttribute('visibility','hidden')})});
</script></body></html>`;
}
