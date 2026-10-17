/**
 * Owner-only "Post to TikTok" page (/api/admin/tiktok?key=…). Follows TikTok's content-sharing guidelines for Direct
 * Post: shows who the post goes out as, offers exactly the privacy levels TikTok returns (none pre-selected), honours
 * the account's comment/duet/stitch settings, and asks for the music-usage consent before the Post button works.
 */
import type { CreatorInfo, TikTokAuth, TikTokPostRow } from '../tiktok';

export interface TikTokAdminView {
  enabled: boolean;
  auth: TikTokAuth | null;
  creator: CreatorInfo | null;
  creatorError: string;
  posts: TikTokPostRow[];
  maxBytes: number;
  /** A rendered pipeline video to load into the form (?video=<slug>). */
  prefill?: { slug: string; caption: string; title: string } | null;
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
  const privacy = ci?.privacy_level_options ?? [];
  const rows = v.posts.map((p) => `<tr><td>${esc(p.created_at.slice(0, 16).replace('T', ' '))}</td><td>${esc(p.title.slice(0, 60))}${p.title.length > 60 ? '…' : ''}</td><td>${esc(PRIVACY_LABELS[p.privacy] ?? p.privacy)}</td><td data-publish="${esc(p.publish_id)}">${esc(statusLabel(p.status))}${p.fail_reason ? ` <small>${esc(p.fail_reason)}</small>` : ''}</td></tr>`).join('');
  const body = !v.enabled
    ? `<p class="warn">TikTok keys are not set on the Worker (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET).</p>`
    : !connected
      ? `<p>No TikTok account is connected yet.</p><p><a class="btn" href="/api/tiktok/connect?key=__KEY__">Connect TikTok</a></p>`
      : !ci
        ? `<p class="warn">Connected as <strong>${esc(v.auth!.display_name || v.auth!.open_id)}</strong>, but TikTok did not answer the creator-info call: ${esc(v.creatorError)}</p><p><a class="btn" href="/api/tiktok/connect?key=__KEY__">Reconnect</a></p>`
        : `
<section class="who">
  ${ci.creator_avatar_url ? `<img src="${esc(ci.creator_avatar_url)}" alt="" width="56" height="56">` : ''}
  <div><div class="small">Posting as</div><strong>${esc(ci.creator_nickname)}</strong> <span class="small">@${esc(ci.creator_username)}</span></div>
  <a class="small" href="/api/tiktok/connect?key=__KEY__">switch account</a>
</section>
<form id="f" ${v.prefill ? `data-video="${esc(v.prefill.slug)}"` : ''}>
  ${v.prefill ? `<p class="who" id="pipeline"><span>From the pipeline: <strong>${esc(v.prefill.title)}</strong> <span class="small" id="pipeline-state">loading the video…</span></span></p>` : ''}
  <label>Video (mp4, up to ${Math.round(v.maxBytes / 1048576)} MB, max ${Math.round(ci.max_video_post_duration_sec / 60)} min)
    <input type="file" name="video" accept="video/mp4,video/quicktime" required>
  </label>
  <video id="preview" playsinline muted controls hidden></video>
  <label>Caption <span class="small" id="count">${v.prefill ? v.prefill.caption.length : 0} / 2200</span>
    <textarea name="title" maxlength="2200" rows="4" placeholder="What the video is about, plus #hashtags" required>${v.prefill ? esc(v.prefill.caption) : ''}</textarea>
  </label>
  <label>Who can view this video
    <select name="privacy" required>
      <option value="" selected disabled>Choose…</option>
      ${privacy.map((p) => `<option value="${esc(p)}">${esc(PRIVACY_LABELS[p] ?? p)}</option>`).join('')}
    </select>
  </label>
  <fieldset><legend>Allow users to</legend>
    <label class="row"><input type="checkbox" name="comments" checked ${ci.comment_disabled ? 'disabled' : ''}> Comment${ci.comment_disabled ? ' <span class="small">(off in your TikTok settings)</span>' : ''}</label>
    <label class="row"><input type="checkbox" name="duet" ${ci.duet_disabled ? 'disabled' : ''}> Duet${ci.duet_disabled ? ' <span class="small">(off in your TikTok settings)</span>' : ''}</label>
    <label class="row"><input type="checkbox" name="stitch" ${ci.stitch_disabled ? 'disabled' : ''}> Stitch${ci.stitch_disabled ? ' <span class="small">(off in your TikTok settings)</span>' : ''}</label>
  </fieldset>
  <label class="consent"><input type="checkbox" name="consent" required>By posting, you agree to TikTok's <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener">Music Usage Confirmation</a>.</label>
  <button type="submit" class="btn" id="go" disabled>Post to TikTok</button>
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
  var MAX = ${v.maxBytes}, MAXSEC = ${ci?.max_video_post_duration_sec ?? 600};
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
    go.disabled = true; go.textContent = 'Uploading…';
    var q = new URLSearchParams({ key: K, title: title.value.trim(), privacy: privacy.value, comments: f.comments.checked ? 'on' : 'off', duet: f.duet.checked ? 'on' : 'off', stitch: f.stitch.checked ? 'on' : 'off', cover_ms: '1500' });
    if (slug) q.set('video', slug);
    fetch('/api/tiktok/post?' + q, { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: file.files[0] })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) { show('bad', 'TikTok refused the post: ' + (j.error || 'unknown error')); go.disabled = false; go.textContent = 'Post to TikTok'; return; }
        show('ok', 'Uploaded. TikTok is processing the video (' + j.privacy.replace(/_/g, ' ').toLowerCase() + ')…');
        go.textContent = 'Posted';
        var tries = 0;
        (function poll() {
          fetch('/api/tiktok/post/' + encodeURIComponent(j.publish_id) + '?key=' + encodeURIComponent(K)).then(function (r) { return r.json(); }).then(function (s) {
            if (s.status === 'PUBLISH_COMPLETE') { show('ok', 'Published on TikTok. Open the app to see it on your profile.'); setTimeout(function () { location.reload(); }, 2500); }
            else if (s.status === 'FAILED') { show('bad', 'TikTok could not publish it: ' + (s.fail_reason || 'no reason given')); }
            else if (++tries < 60) { show('ok', 'Processing… (' + (s.status || 'waiting') + ')'); setTimeout(poll, 5000); }
            else { show('ok', 'Still processing; check the list below in a few minutes.'); }
          }).catch(function () { setTimeout(poll, 8000); });
        })();
      })
      .catch(function (err) { show('bad', 'Upload failed: ' + err); go.disabled = false; go.textContent = 'Post to TikTok'; });
  });
})();
</script></body></html>`;
}
