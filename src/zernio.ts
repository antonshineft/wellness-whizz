/**
 * Zernio (zernio.com): one API that posts to TikTok, Instagram and other networks through Zernio's own approved apps,
 * so a TikTok video can go out publicly without our own TikTok app passing review. The owner connects the social
 * accounts in the Zernio dashboard; the posting page lists them and posts through this module.
 * Needs ZERNIO_API_KEY. Free for the first two connected accounts.
 */

export interface ZernioEnv {
  ZERNIO_API_KEY?: string;
}

const API = 'https://zernio.com/api/v1';

export interface ZernioAccount {
  id: string;
  platform: string;
  name?: string;
  username?: string;
  displayName?: string;
  status?: string;
  profileId?: string;
}

export function zernioEnabled(env: ZernioEnv): boolean {
  return !!env.ZERNIO_API_KEY;
}

async function call<T>(env: ZernioEnv, method: string, path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${env.ZERNIO_API_KEY}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, message: `Could not reach Zernio: ${(e as Error).message}` };
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const err = (json as { error?: unknown; message?: unknown } | null);
    const msg = typeof err?.error === 'string' ? err.error : typeof err?.message === 'string' ? err.message : text.slice(0, 200);
    return { ok: false, message: `Zernio ${path}: HTTP ${res.status} ${msg}` };
  }
  return { ok: true, data: json as T };
}

export async function listAccounts(env: ZernioEnv): Promise<{ ok: true; accounts: ZernioAccount[] } | { ok: false; message: string }> {
  const r = await call<{ accounts: ZernioAccount[] }>(env, 'GET', '/accounts');
  if (!r.ok) return r;
  const accounts = (r.data.accounts ?? []).map((a) => ({
    id: String((a as { id?: string; _id?: string }).id ?? (a as { _id?: string })._id ?? ''),
    platform: String(a.platform ?? ''),
    name: a.name ?? a.displayName ?? a.username ?? '',
    username: a.username,
    status: a.status,
    profileId: a.profileId,
  }));
  return { ok: true, accounts };
}

/** Upload a video to Zernio's media store (presigned PUT) and return its public URL. */
export async function uploadVideo(env: ZernioEnv, bytes: ArrayBuffer, filename: string): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  return uploadMedia(env, bytes, filename, 'video/mp4');
}

/** Upload any media file (video, or a JPEG/PNG cover) to Zernio's media store and return its public URL. */
export async function uploadMedia(env: ZernioEnv, bytes: ArrayBuffer, filename: string, contentType: string): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const p = await call<{ uploadUrl: string; publicUrl: string }>(env, 'POST', '/media/presign', { filename, contentType });
  if (!p.ok) return p;
  let up: Response;
  try {
    up = await fetch(p.data.uploadUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: bytes });
  } catch (e) {
    return { ok: false, message: `Zernio upload: ${(e as Error).message}` };
  }
  if (!up.ok) return { ok: false, message: `Zernio upload: HTTP ${up.status} ${(await up.text().catch(() => '')).slice(0, 200)}` };
  return { ok: true, url: p.data.publicUrl };
}

export interface ZernioPostOptions {
  content: string;
  /** One video (the usual case) ... */
  mediaUrl?: string;
  /** ... or an explicit list, e.g. several images for an Instagram carousel. */
  mediaItems?: { type: 'image' | 'video'; url: string }[];
  targets: { platform: string; accountId: string }[];
  /** TikTok: only PUBLIC_TO_EVERYONE publishes directly; anything else goes to TikTok drafts (draft: true). */
  privacy?: string;
  allowComment?: boolean;
  allowDuet?: boolean;
  allowStitch?: boolean;
  madeWithAi?: boolean;
  title?: string;
  /** Instagram: a 1080x1920 JPEG/PNG used as the Reel cover (what the profile grid shows). */
  coverUrl?: string;
  /** When set, the post is scheduled for this local time ("2026-11-06T09:00:00" in `timezone`) instead of published now. */
  scheduledFor?: string;
  timezone?: string;
  /** Instagram: publish as a trial reel (non-followers only, not on the profile). MANUAL: it graduates only when the owner says so. */
  trial?: 'MANUAL' | 'SS_PERFORMANCE';
  /** Instagram reels: false keeps the reel out of the feed and the main profile grid (it shows in the Reels tab only). */
  shareToFeed?: boolean;
}

export async function createPost(env: ZernioEnv, o: ZernioPostOptions): Promise<{ ok: true; id: string; status: string } | { ok: false; message: string }> {
  const hasTikTok = o.targets.some((t) => t.platform === 'tiktok');
  const privacy = o.privacy || 'PUBLIC_TO_EVERYONE';
  const body: Record<string, unknown> = {
    content: o.content,
    ...(o.scheduledFor ? { publishNow: false, scheduledFor: o.scheduledFor, timezone: o.timezone ?? 'Europe/Madrid' } : { publishNow: true }),
    platforms: o.targets.map((t) => {
      const ig = t.platform === 'instagram' ? { ...(o.coverUrl ? { instagramThumbnail: o.coverUrl } : {}), ...(o.trial ? { trialParams: { graduationStrategy: o.trial } } : {}), ...(o.shareToFeed === false ? { shareToFeed: false } : {}) } : {};
      return Object.keys(ig).length ? { platform: t.platform, accountId: t.accountId, platformSpecificData: ig } : { platform: t.platform, accountId: t.accountId };
    }),
    mediaItems: o.mediaItems ?? (o.mediaUrl ? [{ type: 'video', url: o.mediaUrl }] : []),
    title: (o.title ?? o.content).slice(0, 100),
    visibility: 'public',
  };
  if (hasTikTok) {
    body.tiktokSettings = {
      privacy_level: privacy === 'PUBLIC_TO_EVERYONE' ? 'PUBLIC_TO_EVERYONE' : privacy,
      allow_comment: o.allowComment ?? true,
      allow_duet: o.allowDuet ?? false,
      allow_stitch: o.allowStitch ?? false,
      commercial_content_type: 'none',
      content_preview_confirmed: true,
      express_consent_given: true,
      media_type: 'video',
      auto_add_music: false,
      video_made_with_ai: o.madeWithAi ?? true,
      ...(privacy !== 'PUBLIC_TO_EVERYONE' ? { draft: true } : {}),
    };
  }
  const r = await call<{ post: { _id: string; status: string } }>(env, 'POST', '/posts', body);
  if (!r.ok) return r;
  return { ok: true, id: r.data.post?._id ?? '', status: r.data.post?.status ?? 'unknown' };
}

/** The local dates (YYYY-MM-DD in the post's timezone, as Zernio stores them in UTC) that already have a scheduled post. */
export async function scheduledDays(env: ZernioEnv, timezone: string): Promise<Set<string>> {
  const r = await call<{ posts?: { status?: string; scheduledFor?: string }[] }>(env, 'GET', '/posts?limit=100');
  const days = new Set<string>();
  if (!r.ok) return days;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  for (const p of r.data.posts ?? []) {
    if (p.status === 'scheduled' && p.scheduledFor) days.add(fmt.format(new Date(p.scheduledFor)));
  }
  return days;
}

export async function getPost(env: ZernioEnv, id: string): Promise<{ ok: true; post: unknown } | { ok: false; message: string }> {
  const r = await call<unknown>(env, 'GET', `/posts/${encodeURIComponent(id)}`);
  return r.ok ? { ok: true, post: r.data } : r;
}

/** One post's numbers from Zernio's analytics (Instagram: views, reach, reelsSkipRate, igReelsAvgWatchTime in ms, likes, shares, saves ...). */
export async function postAnalytics(env: ZernioEnv, id: string): Promise<{ ok: true; metrics: Record<string, unknown> } | { ok: false; message: string }> {
  const r = await call<Record<string, unknown>>(env, 'GET', `/analytics?postId=${encodeURIComponent(id)}`);
  if (!r.ok) return r;
  const d = r.data ?? {};
  const first = <T>(v: unknown): T | undefined => (Array.isArray(v) ? (v[0] as T) : undefined);
  const post = (d.post as Record<string, unknown> | undefined) ?? first<Record<string, unknown>>(d.posts) ?? d;
  const perPlatform = first<Record<string, unknown>>(post.platformAnalytics) ?? first<Record<string, unknown>>(post.platforms);
  const metrics = (post.analytics as Record<string, unknown> | undefined) ?? (perPlatform?.analytics as Record<string, unknown> | undefined);
  return metrics ? { ok: true, metrics } : { ok: false, message: 'no numbers yet' };
}

/** One post's full analytics answer from Zernio (aggregate `analytics` plus `platformAnalytics` per platform). */
export async function postAnalyticsRaw(env: ZernioEnv, id: string): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; message: string }> {
  const r = await call<Record<string, unknown>>(env, 'GET', `/analytics?postId=${encodeURIComponent(id)}`);
  return r.ok ? { ok: true, data: r.data ?? {} } : r;
}

/** Remove a post that has not been published yet (a scheduled or failed one). */
export async function deletePost(env: ZernioEnv, id: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await call<unknown>(env, 'DELETE', `/posts/${encodeURIComponent(id)}`);
  return r.ok ? { ok: true } : r;
}

/** The most recently published posts, newest first (id, when they went out, whether they carry a video, and that video's address). */
export async function recentPublished(env: ZernioEnv, limit = 20): Promise<{ id: string; at: string; video: boolean; mediaUrl: string }[]> {
  const r = await call<{ posts?: { _id?: string; publishedAt?: string; scheduledFor?: string; mediaItems?: { type?: string; url?: string }[] }[] }>(env, 'GET', `/posts?status=published&limit=${limit}`);
  if (!r.ok) return [];
  return (r.data.posts ?? []).map((p) => {
    const file = (p.mediaItems ?? []).find((m) => m.type === 'video');
    return { id: String(p._id ?? ''), at: String(p.publishedAt ?? p.scheduledFor ?? ''), video: !!file, mediaUrl: String(file?.url ?? '') };
  });
}
