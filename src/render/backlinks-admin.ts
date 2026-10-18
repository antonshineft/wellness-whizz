/** Owner page for the backlink outreach (/api/admin/backlinks?key=…): queue by status, approve or edit drafts, add prospects. */
import type { LinkEvent, Prospect } from '../backlinks';

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

export interface BacklinksView {
  counts: Record<string, number>;
  status: string;
  rows: Prospect[];
  events: Record<number, LinkEvent[]>;
  perDay: number;
  autosend: boolean;
  emailReady: boolean;
  message: string;
  directories: { name: string; url: string; category: string; status: string; note: string }[];
}

const ORDER = ['drafted', 'new', 'sent', 'followed-up', 'replied', 'won', 'no-contact', 'declined', 'skipped'];

export function renderBacklinksAdmin(v: BacklinksView): string {
  const tabs = ORDER.map((s) => `<a class="tab ${v.status === s ? 'on' : ''}" href="?key=__KEY__&status=${s}">${esc(s)} <span class="n">${v.counts[s] ?? 0}</span></a>`).join('');
  const rows = v.rows.map((p) => {
    const draft = p.status === 'drafted';
    return `<article class="card" id="p${p.id}">
  <div class="head"><a href="${esc(p.url)}" target="_blank" rel="noopener"><strong>${esc(p.title || p.domain)}</strong></a> <span class="small">${esc(p.domain)} · ${esc(p.kind)} · ${esc(p.language)} · fit ${p.score}</span></div>
  <p class="small">${esc(p.why)}${p.notes ? ` · ${esc(p.notes)}` : ''}</p>
  ${(v.events[p.id] ?? []).length ? `<p class="small log">${(v.events[p.id] ?? []).map((e) => `${esc(e.at.slice(0, 16))} ${esc(e.kind)}${e.detail ? ': ' + esc(e.detail.slice(0, 140)) : ''}`).join('<br>')}</p>` : ''}
  <form method="post" action="/api/admin/backlinks/act?key=__KEY__&status=${esc(v.status)}">
    <input type="hidden" name="id" value="${p.id}">
    <label class="small">To <input name="email" value="${esc(p.contact_email)}" placeholder="${p.contact_url ? 'no address; contact form: ' + esc(p.contact_url) : 'no address found'}"></label>
    ${draft || p.status === 'sent' || p.status === 'followed-up' ? `<label class="small">Subject <input name="subject" value="${esc(p.draft_subject)}" ${draft ? '' : 'readonly'}></label>
    <textarea name="body" rows="9" ${draft ? '' : 'readonly'}>${esc(p.draft_body)}</textarea>` : ''}
    <div class="actions">
      ${draft ? `<button name="action" value="send" class="btn">Send now</button> <button name="action" value="approve" class="btn alt">${p.approved ? 'Approved ✓ (save edits)' : 'Approve for today\'s batch'}</button> <button name="action" value="redraft" class="btn alt">Rewrite</button>` : ''}
      ${p.status === 'no-contact' ? `<button name="action" value="contact" class="btn">Save address</button>` : ''}
      ${['sent', 'followed-up', 'replied'].includes(p.status) ? `<button name="action" value="won" class="btn">Mark won</button> <button name="action" value="declined" class="btn alt">Declined</button>` : ''}
      ${p.status !== 'skipped' && p.status !== 'won' ? `<button name="action" value="skip" class="btn alt">Skip</button>` : ''}
      ${p.status === 'won' && p.won_url ? `<a class="small" href="${esc(p.won_url)}" target="_blank" rel="noopener">link page</a>` : ''}
      ${p.sent_at ? `<span class="small">sent ${esc(p.sent_at.slice(0, 10))}</span>` : ''}
    </div>
  </form>
</article>`;
  }).join('');
  const dirs = v.directories.map((d) => `<li class="${esc(d.status)}"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a> <span class="small">${esc(d.category)}${d.note ? ' · ' + esc(d.note) : ''}</span>
    <form method="post" action="/api/admin/backlinks/directory?key=__KEY__" class="inline"><input type="hidden" name="name" value="${esc(d.name)}"><select name="status"><option ${d.status === 'todo' ? 'selected' : ''}>todo</option><option ${d.status === 'submitted' ? 'selected' : ''}>submitted</option><option ${d.status === 'live' ? 'selected' : ''}>live</option><option ${d.status === 'rejected' ? 'selected' : ''}>rejected</option><option ${d.status === 'skip' ? 'selected' : ''}>skip</option></select> <input name="url" placeholder="listing URL" value="${esc(d.url && d.status !== 'todo' ? '' : '')}"> <button class="btn alt">Save</button></form></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Backlinks · Wellness Whizz</title>
<style>
body{margin:0;padding:20px 14px 60px;background:#fdf1cf;color:#1d272d;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.45}
main{max-width:720px;margin:0 auto}
h1{font-size:24px;margin:0 0 6px}h2{font-size:19px;margin:30px 0 8px}
.small{font-size:13px;color:#6b7478}
.log{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word}
.msg{background:#e8f6e4;border:1px solid #87d581;border-radius:10px;padding:10px 12px;margin:10px 0}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
.tab{background:#fff;border-radius:999px;padding:6px 12px;text-decoration:none;color:#1d272d;font-size:14px}
.tab.on{background:#1d272d;color:#fdf1cf}.tab .n{opacity:.7}
.card{background:#fff;border-radius:14px;padding:12px 14px;margin:10px 0}
.card .head a{color:#1d272d;text-decoration:none}
input,textarea,select{width:100%;box-sizing:border-box;font:inherit;padding:8px 10px;border:1px solid #d8d2bf;border-radius:10px;background:#fffdf7;margin:4px 0 8px}
textarea{font-size:15px}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.btn{border:0;border-radius:999px;background:#1d272d;color:#fdf1cf;padding:9px 14px;font:inherit;font-size:14px;cursor:pointer;text-decoration:none}
.btn.alt{background:#e6dfc9;color:#1d272d}
.tools{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
ul.dirs{padding-left:18px}ul.dirs li{margin:6px 0}ul.dirs li.live{color:#2e7d32}ul.dirs li.skip,ul.dirs li.rejected{opacity:.5}
form.inline{display:inline-flex;gap:6px;align-items:center;margin-left:6px}form.inline input,form.inline select{width:auto;margin:0;padding:4px 8px;font-size:13px}form.inline .btn{padding:5px 10px;font-size:13px}
</style></head><body><main>
<h1>Backlinks</h1>
<p class="small">Sending from hello@aiww.io: ${v.perDay} a day, ${v.autosend ? 'automatic' : 'only approved drafts'}${v.emailReady ? '' : ' · email is not configured, nothing goes out'}.</p>
${v.message ? `<p class="msg">${esc(v.message)}</p>` : ''}
<div class="tools">
  <form method="post" action="/api/admin/backlinks/run?key=__KEY__&step=discover"><button class="btn">Find more prospects</button></form>
  <form method="post" action="/api/admin/backlinks/run?key=__KEY__&step=contacts"><button class="btn alt">Find contacts</button></form>
  <form method="post" action="/api/admin/backlinks/run?key=__KEY__&step=draft"><button class="btn alt">Write drafts</button></form>
  <form method="post" action="/api/admin/backlinks/run?key=__KEY__&step=send"><button class="btn alt">Send approved</button></form>
  <form method="post" action="/api/admin/backlinks/run?key=__KEY__&step=wins"><button class="btn alt">Check for new links</button></form>
</div>
<form method="post" action="/api/admin/backlinks/add?key=__KEY__" class="card">
  <label class="small">Add a prospect by URL <input name="url" placeholder="https://…" required></label>
  <div class="actions"><select name="kind" style="width:auto;margin:0"><option value="resource-page">resource page</option><option value="guest-post">guest post</option><option value="blog">blog</option><option value="tool-list">tool list</option><option value="newsletter">newsletter</option><option value="journalist">journalist</option></select> <input name="note" placeholder="why it fits" style="flex:1;margin:0"> <button class="btn">Add</button></div>
</form>
<div class="tabs">${tabs}</div>
${rows || '<p class="small">Nothing here.</p>'}
<h2>Directories and profiles (your accounts)</h2>
<p class="small">Free listings that give a link and some reputation. Each needs an account under your email; the kit page has the copy and images to paste.
<a href="/api/admin/backlinks/kit?key=__KEY__">Open the submission kit</a>.</p>
<ul class="dirs">${dirs}</ul>
</main>
<script>document.querySelectorAll('[href*="__KEY__"],[action*="__KEY__"]').forEach(function(a){var k=new URLSearchParams(location.search).get('key')||'';if(a.href)a.href=a.href.replace('__KEY__',encodeURIComponent(k));if(a.getAttribute('action'))a.setAttribute('action',a.getAttribute('action').replace('__KEY__',encodeURIComponent(k)));});</script>
</body></html>`;
}
