/**
 * Owner-only "Post to TikTok" page (/api/admin/tiktok?key=…). Follows TikTok's content-sharing guidelines for Direct
 * Post: shows who the post goes out as, offers exactly the privacy levels TikTok returns (none pre-selected), honours
 * the account's comment/duet/stitch settings, and asks for the music-usage consent before the Post button works.
 */
import type { CreatorInfo, TikTokAuth, TikTokPostRow } from '../tiktok';
import type { ZernioAccount } from '../zernio';

export interface TikTokAdminView {
  enabled: boolean;
  auth: TikTokAuth | null;
  creator: CreatorInfo | null;
  creatorError: string;
  posts: TikTokPostRow[];
  maxBytes: number;
  /** A rendered pipeline video to load into the form (?video=<slug>). */
  prefill?: { slug: string; caption: string; title: string } | null;
  /** Zernio accounts (null when ZERNIO_API_KEY is not set). */
  zernio?: { accounts: ZernioAccount[]; error: string } | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

const PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends (mutual followers)',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me',
};

function statusLabel(s: string): string {
  return ({ PUBLISH_COMPLETE: 'Published', FAILED: 'Failed', UPLOADED: 'Uploaded, processing', PROCESSING_UPLOAD: 'Processing', PROCESSING_DOWNLOAD: 'Processing', SEND_TO_USER_INBOX: 'Sent to inbox' } as Record<string, string>)[s] ?? s;
}

export function renderTikTokAdmin(v: TikTokAdminView): string {
  const connected = !!v.auth;
  const ci = v.creator;
  const rows = v.posts.map((p) => `<tr><td>${esc(p.created_at.slice(0, 16).replace('T', ' '))}</td><td>${esc(p.title.slice(0, 60))}${p.title.length > 60 ? '…' : ''}</td><td>${esc(PRIVACY_LABELS[p.privacy] ?? p.privacy)}</td><td data-publish="${esc(p.publish_id)}">${esc(statusLabel(p.status))}${p.fail_reason ? ` <small>${esc(p.fail_reason)}</small>` : ''}</td></tr>`).join('');
  const zAccounts = v.zernio?.accounts ?? [];
  const direct = !!(v.enabled && connected && ci);
  const privacyOptions = ci?.privacy_level_options ?? ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'];
  const maxSec = ci?.max_video_post_duration_sec ?? 600;
  const targets = [
    ...(direct ? [`<label class="row"><input type="checkbox" name="target" value="direct" checked> TikTok <strong>@${esc(ci!.creator_username)}</strong> <span class="small">(our app, ${esc(privacyOptions.includes('PUBLIC_TO_EVERYONE') ? 'public allowed' : 'private only until review')})</span></label>`] : []),
    ...zAccounts.map((a) => `<label class="row"><input type="checkbox" name="target" value="zernio:${esc(a.platform)}:${esc(a.id)}" ${direct ? '' : 'checked'}> ${esc(a.platform.charAt(0).toUpperCase() + a.platform.slice(1))} <strong>${esc(a.name || a.username || a.id)}</strong> <span class="small">(via Zernio)</span></label>`),
  ];
  const zernioNote = v.zernio?.error ? `<p class="warn">Zernio did not answer: ${esc(v.zernio.error)}</p>` : v.zernio && !zAccounts.length ? `<p class="small">Zernio is set up but has no connected accounts yet: connect TikTok or Instagram at <a href="https://zernio.com" target="_blank" rel="noopener">zernio.com</a>.</p>` : '';
  const body = !targets.length
    ? `${!v.enabled ? '<p class="warn">TikTok keys are not set on the Worker (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET).</p>' : !connected ? '<p>No TikTok account is connected yet.</p><p><a class="btn" href="/api/tiktok/connect?key=__KEY__">Connect TikTok</a></p>' : `<p class="warn">Connected as <strong>${esc(v.auth!.display_name || v.auth!.open_id)}</strong>, but TikTok did not answer the creator-info call: ${esc(v.creatorError)}</p><p><a class="btn" href="/api/tiktok/connect?key=__KEY__">Reconnect</a></p>`}${zernioNote}`
    : `
${direct ? `<section class="who">
  ${ci!.creator_avatar_url ? `<img src="${esc(ci!.creator_avatar_url)}" alt="" width="56" height="56">` : ''}
  <div><div class="small">Posting as</div><strong>${esc(ci!.creator_nickname)}</strong> <span class="small">@${esc(ci!.creator_username)}</span></div>
  <a class="small" href="/api/tiktok/connect?key=__KEY__">switch account</a>
</section>` : ''}
${zernioNote}
<form id="f" ${v.prefill ? `data-video="${esc(v.prefill.slug)}"` : ''}>
  <fieldset><legend>Post to</legend>${targets.join('')}</fieldset>
  ${v.prefill ? `<p class="who" id="pipeline"><span>From the pipeline: <strong>${esc(v.prefill.title)}</strong> <span class="small" id="pipeline-state">loading the video…</span></span></p>` : ''}
  <label>Video (mp4, up to ${Math.round(v.maxBytes / 1048576)} MB, max ${Math.round(maxSec / 60)} min)
    <input type="file" name="video" accept="video/mp4,video/quicktime" required>
  </label>
  <video id="preview" playsinline muted controls hidden></video>
  <label>Caption <span class="small" id="count">${v.prefill ? v.prefill.caption.length : 0} / 2200</span>
    <textarea name="title" maxlength="2200" rows="4" placeholder="What the video is about, plus #hashtags" required>${v.prefill ? esc(v.prefill.caption) : ''}</textarea>
  </label>
  <label>Who can view this video
    <select name="privacy" required>
      <option value="" selected disabled>Choose…</option>
      ${privacyOptions.map((p) => `<option value="${esc(p)}">${esc(PRIVACY_LABELS[p] ?? p)}</option>`).join('')}
    </select>
  </label>
  <fieldset><legend>Allow users to</legend>
    <label class="row"><input type="checkbox" name="comments" checked ${ci?.comment_disabled ? 'disabled' : ''}> Comment${ci?.comment_disabled ? ' <span class="small">(off in your TikTok settings)</span>' : ''}</label>
    <label class="row"><input type="checkbox" name="duet" ${ci?.duet_disabled ? 'disabled' : ''}> Duet${ci?.duet_disabled ? ' <span class="small">(off in your TikTok settings)</span>' : ''}</label>
    <label class="row"><input type="checkbox" name="stitch" ${ci?.stitch_disabled ? 'disabled' : ''}> Stitch${ci?.stitch_disabled ? ' <span class="small">(off in your TikTok settings)</span>' : ''}</label>
  </fieldset>
  <label class="row"><input type="checkbox" name="ai" checked> Label as AI-generated content (TikTok asks for this on avatar videos)</label>
  <label class="consent"><input type="checkbox" name="consent" required>By posting, you agree to TikTok's <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener">Music Usage Confirmation</a>.</label>
  <button type="submit" class="btn" id="go" disabled>Post</button>
  <p class="small">The video is uploaded to TikTok as soon as you press Post. It may take a minute or two to process; this page shows the result.</p>
</form>
<div id="result" hidden></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Post to TikTok · Wellness Whizz</title>
<style>
:root{color-scheme:light}
body{margin:0;padding:24px 16px 48px;background:#fdf1cf;color:#1d272d;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:17px;line-height:1.45}
main{max-width:560px;margin:0 auto}
h1{font-size:26px;margin:0 0 16px}
h2{font-size:20px;margin:32px 0 8px}
.who{display:flex;align-items:center;gap:12px;background:#fff;border-radius:16px;padding:12px 16px;margin-bottom:16px}
.who img{border-radius:50%}
.who>div{flex:1}
.small{font-size:14px;color:#6b7478}
label{display:block;margin:14px 0 0;font-weight:600}
label input[type=file],textarea,select{display:block;width:100%;box-sizing:border-box;margin-top:6px;font:inherit;font-weight:400;padding:10px 12px;border:1px solid #d8d2bf;border-radius:12px;background:#fff}
.row{display:flex;align-items:center;gap:10px;font-weight:400;margin:8px 0 0}
.row input{width:20px;height:20px;margin:0}
fieldset{border:1px solid #d8d2bf;border-radius:12px;margin:16px 0 0;padding:8px 12px 12px}
legend{font-weight:600;padding:0 6px}
.consent{display:block;margin-top:16px;font-weight:400;line-height:1.5}
.consent input{width:20px;height:20px;vertical-align:-4px;margin:0 8px 0 0}
.btn{display:inline-block;margin-top:18px;padding:14px 22px;border:0;border-radius:999px;background:#1d272d;color:#fdf1cf;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}
.btn[disabled]{opacity:.45;cursor:not-allowed}
video{width:160px;border-radius:12px;margin-top:10px;background:#000}
.warn{background:#fff3f0;border:1px solid #f1b8ad;border-radius:12px;padding:12px 16px}
#result{margin-top:18px;padding:14px 16px;border-radius:12px;background:#fff}
#result.ok{border:1px solid #87d581}
#result.bad{border:1px solid #f1b8ad}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:8px 6px;border-top:1px solid #e6dfc9;vertical-align:top}
</style></head><body><main>
<h1>Post to TikTok</h1>
${body}
<h2>Recent posts</h2>
${rows ? `<table>${rows}</table>` : '<p class="small">Nothing posted through the site yet.</p>'}
</main>
<script>
(function () {
  var K = new URLSearchParams(location.search).get('key') || '';
  document.querySelectorAll('a[href*="__KEY__"]').forEach(function (a) { a.href = a.href.replace('__KEY__', encodeURIComponent(K)); });
  var f = document.getElementById('f'); if (!f) return;
  var go = document.getElementById('go'), file = f.video, title = f.title, privacy = f.privacy, consent = f.consent, count = document.getElementById('count'), prev = document.getElementById('preview'), result = document.getElementById('result');
  var MAX = ${v.maxBytes}, MAXSEC = ${maxSec};
  function ready() { go.disabled = !(file.files && file.files[0] && title.value.trim() && privacy.value && consent.checked); }
  ['input', 'change'].forEach(function (ev) { f.addEventListener(ev, ready); });
  title.addEventListener('input', function () { count.textContent = title.value.length + ' / 2200'; });
  file.addEventListener('change', function () {
    var v = file.files[0]; prev.hidden = !v; if (!v) return;
    if (v.size > MAX) { show('bad', 'That file is ' + (v.size / 1048576).toFixed(1) + ' MB; the limit is ' + Math.round(MAX / 1048576) + ' MB.'); file.value = ''; prev.hidden = true; return; }
    prev.src = URL.createObjectURL(v);
    prev.onloadedmetadata = function () { if (prev.duration > MAXSEC) { show('bad', 'That video is longer than this account may post (' + MAXSEC + ' s).'); file.value = ''; prev.hidden = true; ready(); } };
  });
  function show(cls, html) { result.hidden = false; result.className = cls; result.innerHTML = html; }
  var slug = f.getAttribute('data-video');
  if (slug) {
    var st = document.getElementById('pipeline-state');
    fetch('/api/admin/videos/' + encodeURIComponent(slug) + '/file?key=' + encodeURIComponent(K)).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }).then(function (b) {
      var dt = new DataTransfer(); dt.items.add(new File([b], slug + '.mp4', { type: 'video/mp4' })); file.files = dt.files;
      file.dispatchEvent(new Event('change')); st.textContent = (b.size / 1048576).toFixed(1) + ' MB loaded'; ready();
    }).catch(function (e) { st.textContent = 'could not load the video (' + e.message + '); pick the file by hand.'; });
  }
  f.addEventListener('submit', function (e) {
    e.preventDefault(); if (go.disabled) return;
    var targets = Array.prototype.slice.call(f.querySelectorAll('input[name=target]:checked')).map(function (t) { return t.value; });
    if (!targets.length) { show('bad', 'Tick at least one account under "Post to".'); return; }
    go.disabled = true; go.textContent = 'Uploading…';
    var base = { key: K, title: title.value.trim(), privacy: privacy.value, comments: f.comments.checked ? 'on' : 'off', duet: f.duet.checked ? 'on' : 'off', stitch: f.stitch.checked ? 'on' : 'off', ai: f.ai.checked ? 'on' : 'off', cover_ms: '1500' };
    if (slug) base.video = slug;
    var lines = [];
    function line(cls, text) { lines.push(text); show(cls, lines.join('<br>')); }
    var zernioAccounts = targets.filter(function (t) { return t.indexOf('zernio:') === 0; }).map(function (t) { return t.slice(7); });
    var jobs = [];
    if (targets.indexOf('direct') >= 0) jobs.push(function () {
      var q = new URLSearchParams(base);
      return fetch('/api/tiktok/post?' + q, { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: file.files[0] }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) { line('bad', 'TikTok (our app) refused the post: ' + (j.error || 'unknown error')); return; }
        line('ok', 'TikTok (our app): uploaded, processing (' + j.privacy.replace(/_/g, ' ').toLowerCase() + ')…');
        var tries = 0;
        return new Promise(function (resolve) { (function poll() {
          fetch('/api/tiktok/post/' + encodeURIComponent(j.publish_id) + '?key=' + encodeURIComponent(K)).then(function (r) { return r.json(); }).then(function (s) {
            if (s.status === 'PUBLISH_COMPLETE') { line('ok', 'TikTok (our app): published.'); resolve(); }
            else if (s.status === 'FAILED') { line('bad', 'TikTok (our app) could not publish it: ' + (s.fail_reason || 'no reason given')); resolve(); }
            else if (++tries < 60) { setTimeout(poll, 5000); }
            else { line('ok', 'TikTok (our app): still processing; check the list below later.'); resolve(); }
          }).catch(function () { setTimeout(poll, 8000); });
        })(); });
      });
    });
    if (zernioAccounts.length) jobs.push(function () {
      var q = new URLSearchParams(base); q.set('accounts', zernioAccounts.join(','));
      return fetch('/api/admin/zernio/post?' + q, { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: file.files[0] }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) { line('bad', 'Zernio refused the post: ' + (j.error || 'unknown error')); return; }
        line('ok', 'Zernio: post ' + j.post_id + ' created (' + j.status + '). It publishes within a few minutes; the Zernio dashboard shows the result per network.');
      });
    });
    jobs.reduce(function (p, job) { return p.then(job); }, Promise.resolve())
      .then(function () { go.textContent = 'Posted'; setTimeout(function () { location.reload(); }, 4000); })
      .catch(function (err) { line('bad', 'Upload failed: ' + err); go.disabled = false; go.textContent = 'Post'; });
  });
})();
</script></body></html>`;
}
