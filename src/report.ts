/**
 * The Monday numbers email: what happened on the site in the last seven days against the seven before, sent to the
 * alert address (ALERT_EMAIL, else the EMAIL_FROM address) by the weekly cron in src/index.ts. Plain reading for the
 * owner; the full figures stay on /api/stats.
 */
import type { ContentProgress, WeeklyNumbers } from './db';
import { escapeHtml } from './html';

/** Crawlers are excluded from the event log from this date; a report that covers earlier days says so. */
const BOT_FILTER_SINCE = '2026-10-10';

interface Line {
  label: string;
  now: number;
  before: number;
}

const fmt = (n: number) => n.toLocaleString('en-GB');

/** "+12%" / "-5%" / "new" / "same"; nothing when both weeks are empty. */
function change(now: number, before: number): string {
  if (now === before) return now ? 'same' : '';
  if (!before) return 'new';
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

function lines(n: WeeklyNumbers): Line[] {
  const ev = (type: keyof WeeklyNumbers['events'], label: string): Line => ({ label, now: n.events[type].this_week, before: n.events[type].last_week });
  return [
    ev('home_view', 'Home page visits'),
    ev('quiz_view', 'Quiz page visits'),
    { label: 'Quizzes started', now: n.quizzes.this_week, before: n.quizzes.last_week },
    ev('result_view', 'Result pages viewed'),
    ev('supplement_view', 'Supplement pages viewed'),
    ev('outbound_click', 'Clicks through to iHerb'),
    { label: 'New subscribers', now: n.subscribers.this_week, before: n.subscribers.last_week },
    ev('share', 'Results shared'),
  ];
}

function longDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export function weeklyReportEmail(origin: string, n: WeeklyNumbers, content: ContentProgress): { subject: string; html: string; text: string } {
  const rows = lines(n);
  const clicks = n.events.outbound_click.this_week;
  const quizzes = n.quizzes.this_week;
  const visits = n.events.home_view.this_week;
  const subject = `Wellness Whizz this week: ${fmt(quizzes)} ${quizzes === 1 ? 'quiz' : 'quizzes'}, ${fmt(clicks)} ${clicks === 1 ? 'click' : 'clicks'} to iHerb, ${fmt(visits)} home visits`;
  const period = `${longDate(n.from)} to ${longDate(n.to)}`;
  const conversion = n.quizzes.this_week ? Math.round((n.quizzes.completed_this_week / n.quizzes.this_week) * 100) : 0;
  const botNote = n.from < BOT_FILTER_SINCE ? `Crawlers and bots are left out of the counts since ${longDate(BOT_FILTER_SINCE)}; earlier days still include them, so the first comparisons overstate last week.` : 'Crawlers and bots are left out of the counts.';
  const supplementUrl = (slug: string) => `${origin}/supplement/${slug}`;
  const posts = `${n.social.posted_this_week} ${n.social.posted_this_week === 1 ? 'post' : 'posts'} went out this week`;

  // ----- text -----
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const text = [
    `Wellness Whizz, the week of ${period}`,
    '',
    ...rows.map((r) => `${pad(r.label, 26)} ${pad(fmt(r.now), 7)} last week ${fmt(r.before)}${change(r.now, r.before) ? ` (${change(r.now, r.before)})` : ''}`),
    `${pad('Quizzes completed', 26)} ${fmt(n.quizzes.completed_this_week)} of ${fmt(n.quizzes.this_week)} (${conversion}%)${n.quizzes.failed_this_week ? `, ${n.quizzes.failed_this_week} failed` : ''}`,
    '',
    'Most clicked through to iHerb:',
    ...(n.top_clicked.length ? n.top_clicked.map((t) => `  ${t.name}: ${t.clicks}`) : ['  no clicks this week']),
    '',
    'Most viewed supplement pages:',
    ...(n.top_viewed.length ? n.top_viewed.map((t) => `  ${t.name}: ${t.views}`) : ['  none']),
    '',
    'Visitors came from:',
    ...(n.referrers.length ? n.referrers.map((r) => `  ${r.referrer}: ${r.views}`) : ['  only direct visits and search engines that hide the referrer']),
    '',
    `Subscribers: ${fmt(n.subscribers.total)} in total.`,
    `X: ${posts}${n.social.failed_this_week ? `, ${n.social.failed_this_week} failed` : ''}, ${n.social.queued} waiting.`,
    `Research: ${n.research.notes} ${n.research.notes === 1 ? 'note' : 'notes'} on /research, ${n.research.notes_this_week} new this week.`,
    `Catalogue: ${content.supplements} supplements, ${content.with_article} with an article, ${content.with_studies} with studies, ${content.with_faqs} with FAQs, ${content.without_product_photos} without product photos.`,
    '',
    botNote,
    `Full numbers: ${origin}/api/stats?key=<your STATS_KEY>`,
  ].join('\n');

  // ----- html -----
  const cell = (s: string, extra = '') => `<td style="padding:8px 6px;border-top:1px solid #e3e8ea;font-size:14px;line-height:20px;${extra}">${s}</td>`;
  const tableRows = rows
    .map((r) => {
      const delta = change(r.now, r.before);
      const colour = delta.startsWith('+') ? '#2b7a3d' : delta.startsWith('-') ? '#b23b3b' : '#6b7679';
      return `<tr>${cell(escapeHtml(r.label))}${cell(`<b>${fmt(r.now)}</b>`, 'text-align:right')}${cell(fmt(r.before), 'text-align:right;opacity:.7')}${cell(escapeHtml(delta), `text-align:right;color:${colour}`)}</tr>`;
    })
    .join('');
  const list = (items: string[], empty: string) =>
    items.length ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:14px;line-height:22px">${items.join('')}</ul>` : `<p style="margin:6px 0 0;font-size:14px;opacity:.7">${escapeHtml(empty)}</p>`;
  const h2 = (s: string) => `<h2 style="font-size:16px;line-height:22px;margin:22px 0 4px">${escapeHtml(s)}</h2>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f6f7;font-family:Helvetica,Arial,sans-serif;color:#1d272d">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border-radius:24px;padding:28px 24px">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.6">Wellness Whizz</div>
      <h1 style="font-size:24px;line-height:30px;margin:8px 0 4px">Your week in numbers</h1>
      <p style="font-size:14px;line-height:21px;margin:0 0 16px;opacity:.75">${escapeHtml(period)}, compared with the seven days before.</p>
      <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse">
        <tr><th style="text-align:left;font-size:12px;padding:0 6px 6px;opacity:.6">What</th><th style="text-align:right;font-size:12px;padding:0 6px 6px;opacity:.6">This week</th><th style="text-align:right;font-size:12px;padding:0 6px 6px;opacity:.6">Last week</th><th style="text-align:right;font-size:12px;padding:0 6px 6px;opacity:.6">Change</th></tr>
        ${tableRows}
        <tr>${cell('Quizzes completed')}${cell(`<b>${fmt(n.quizzes.completed_this_week)}</b> of ${fmt(n.quizzes.this_week)}`, 'text-align:right')}${cell('', '')}${cell(`${conversion}%${n.quizzes.failed_this_week ? `, ${n.quizzes.failed_this_week} failed` : ''}`, 'text-align:right;color:#6b7679')}</tr>
      </table>
      ${h2('Most clicked through to iHerb')}
      ${list(
        n.top_clicked.map((t) => `<li><a href="${escapeHtml(supplementUrl(t.slug))}" style="color:#1d272d">${escapeHtml(t.name)}</a>: ${t.clicks}</li>`),
        'No clicks to iHerb this week.',
      )}
      ${h2('Most viewed supplement pages')}
      ${list(n.top_viewed.map((t) => `<li><a href="${escapeHtml(supplementUrl(t.slug))}" style="color:#1d272d">${escapeHtml(t.name)}</a>: ${t.views}</li>`), 'None.')}
      ${h2('Visitors came from')}
      ${list(n.referrers.map((r) => `<li>${escapeHtml(r.referrer)}: ${r.views}</li>`), 'Only direct visits and search engines that hide the referrer.')}
      ${h2('Behind the scenes')}
      <ul style="margin:6px 0 0;padding-left:18px;font-size:14px;line-height:22px">
        <li>Subscribers: ${fmt(n.subscribers.total)} in total.</li>
        <li>X: ${escapeHtml(posts)}${n.social.failed_this_week ? `, <b>${n.social.failed_this_week} failed</b>` : ''}, ${n.social.queued} waiting.</li>
        <li>Research: ${n.research.notes} ${n.research.notes === 1 ? 'note' : 'notes'} on <a href="${escapeHtml(`${origin}/research`)}" style="color:#1d272d">/research</a>, ${n.research.notes_this_week} new this week.</li>
        <li>Catalogue: ${content.supplements} supplements, ${content.with_article} with an article, ${content.with_studies} with studies, ${content.with_faqs} with FAQs, ${content.without_product_photos} without product photos.</li>
      </ul>
    </div>
    <p style="font-size:12px;line-height:18px;opacity:.6;padding:16px 8px 0">${escapeHtml(botNote)} Full numbers: ${escapeHtml(origin)}/api/stats?key=&lt;your STATS_KEY&gt;</p>
  </div></body></html>`;
  return { subject, html, text };
}
