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
  const p = await call<{ uploadUrl: string; publicUrl: string }>(env, 'POST', '/media/presign', { filename, contentType: 'video/mp4' });
  if (!p.ok) return p;
  let up: Response;
  try {
    up = await fetch(p.data.uploadUrl, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: bytes });
  } catch (e) {
    return { ok: false, message: `Zernio upload: ${(e as Error).message}` };
  }
  if (!up.ok) return { ok: false, message: `Zernio upload: HTTP ${up.status} ${(await up.text().catch(() => '')).slice(0, 200)}` };
  return { ok: true, url: p.data.publicUrl };
}

export interface ZernioPostOptions {
  content: string;
  mediaUrl: string;
  targets: { platform: string; accountId: string }[];
  /** TikTok: only PUBLIC_TO_EVERYONE publishes directly; anything else goes to TikTok drafts (draft: true). */
  privacy?: string;
  allowComment?: boolean;
  allowDuet?: boolean;
  allowStitch?: boolean;
  madeWithAi?: boolean;
  title?: string;
}

export async function createPost(env: ZernioEnv, o: ZernioPostOptions): Promise<{ ok: true; id: string; status: string } | { ok: false; message: string }> {
  const hasTikTok = o.targets.some((t) => t.platform === 'tiktok');
  const privacy = o.privacy || 'PUBLIC_TO_EVERYONE';
  const body: Record<string, unknown> = {
    content: o.content,
    publishNow: true,
    platforms: o.targets.map((t) => ({ platform: t.platform, accountId: t.accountId })),
    mediaItems: [{ type: 'video', url: o.mediaUrl }],
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

export async function getPost(env: ZernioEnv, id: string): Promise<{ ok: true; post: unknown } | { ok: false; message: string }> {
  const r = await call<unknown>(env, 'GET', `/posts/${encodeURIComponent(id)}`);
  return r.ok ? { ok: true, post: r.data } : r;
}
