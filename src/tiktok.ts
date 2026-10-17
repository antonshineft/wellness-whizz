/**
 * TikTok posting (Content Posting API, Direct Post).
 *
 * One-time connect: the owner opens /api/tiktok/connect?key=<STATS_KEY>, approves the app on TikTok, and the callback
 * stores the account's tokens in the tiktok_auth table (access token 24 h, refresh token 365 d, refreshed on use).
 * Posting: POST /api/tiktok/post with the mp4 as the request body (or {"video_url"} JSON) uploads the file to TikTok
 * in a single chunk (FILE_UPLOAD source, up to 64 MB) and records the publish id in tiktok_posts; the status route
 * asks TikTok how the post is doing. Unaudited apps can only post privately (SELF_ONLY); TikTok lifts that after review.
 */
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

export interface TikTokEnv {
  DB: D1Database;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
}

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const API = 'https://open.tiktokapis.com/v2';
const SCOPES = 'user.info.basic,video.publish';
export const MAX_SINGLE_UPLOAD = 64 * 1024 * 1024;

export interface TikTokAuth {
  open_id: string;
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
  scope: string;
  display_name: string;
  avatar_url: string;
  updated_at: string;
}

export interface TikTokPostRow {
  id: number;
  publish_id: string;
  title: string;
  privacy: string;
  status: string;
  fail_reason: string;
  post_id: string;
  created_at: string;
  updated_at: string;
}

export function tiktokEnabled(env: TikTokEnv): boolean {
  return !!env.TIKTOK_CLIENT_KEY && !!env.TIKTOK_CLIENT_SECRET;
}

export function callbackUrl(origin: string): string {
  return `${origin}/api/tiktok/callback`;
}

/** Step 1 of the connect flow: remember a random state in a cookie and send the owner to TikTok. */
export function startConnect(c: Context, env: TikTokEnv): Response {
  const origin = new URL(c.req.url).origin;
  const state = crypto.randomUUID().replace(/-/g, '');
  setCookie(c, 'tt_state', state, { path: '/api/tiktok', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600 });
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_key', env.TIKTOK_CLIENT_KEY!);
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', callbackUrl(origin));
  u.searchParams.set('state', state);
  return c.redirect(u.toString(), 302);
}

/** Step 2: TikTok sends the owner back with a code; swap it for tokens and store them. */
export async function finishConnect(c: Context, env: TikTokEnv): Promise<{ ok: boolean; message: string; auth?: TikTokAuth }> {
  const origin = new URL(c.req.url).origin;
  const err = c.req.query('error');
  if (err) return { ok: false, message: `TikTok said: ${err} ${c.req.query('error_description') ?? ''}`.trim() };
  const code = c.req.query('code');
  const state = c.req.query('state');
  const expected = getCookie(c, 'tt_state');
  deleteCookie(c, 'tt_state', { path: '/api/tiktok' });
  if (!code) return { ok: false, message: 'No code in the callback.' };
  if (!expected || state !== expected) return { ok: false, message: 'State mismatch: start again from the connect link.' };
  const tok = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: callbackUrl(origin) });
  if (!tok.ok) return { ok: false, message: tok.message };
  const auth = await saveTokens(env, tok.data);
  // Fill in the display name for the status page; not fatal if it fails.
  try {
    const info = await userInfo(auth.access_token);
    if (info) {
      await env.DB.prepare('UPDATE tiktok_auth SET display_name = ?, avatar_url = ? WHERE id = 1').bind(info.display_name, info.avatar_url).run();
      auth.display_name = info.display_name; auth.avatar_url = info.avatar_url;
    }
  } catch { /* ignore */ }
  return { ok: true, message: `Connected as ${auth.display_name || auth.open_id}`, auth };
}

type TokenData = { access_token: string; expires_in: number; open_id: string; refresh_expires_in: number; refresh_token: string; scope: string };

async function tokenRequest(env: TikTokEnv, params: Record<string, string>): Promise<{ ok: true; data: TokenData } | { ok: false; message: string }> {
  const body = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY!, client_secret: env.TIKTOK_CLIENT_SECRET!, ...params });
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' }, body });
  } catch (e) {
    return { ok: false, message: `Could not reach TikTok: ${(e as Error).message}` };
  }
  const json = (await res.json().catch(() => ({}))) as Partial<TokenData> & { error?: string; error_description?: string };
  if (!res.ok || !json.access_token || !json.refresh_token || !json.open_id) {
    return { ok: false, message: `Token request failed (${res.status}): ${json.error ?? ''} ${json.error_description ?? ''}`.trim() };
  }
  return { ok: true, data: json as TokenData };
}

async function saveTokens(env: TikTokEnv, t: TokenData): Promise<TikTokAuth> {
  const now = Date.now();
  const auth: TikTokAuth = {
    open_id: t.open_id,
    access_token: t.access_token,
    access_expires_at: new Date(now + (t.expires_in ?? 86400) * 1000).toISOString(),
    refresh_token: t.refresh_token,
    refresh_expires_at: new Date(now + (t.refresh_expires_in ?? 31536000) * 1000).toISOString(),
    scope: t.scope ?? SCOPES,
    display_name: '',
    avatar_url: '',
    updated_at: new Date(now).toISOString(),
  };
  const prev = await getAuth(env);
  await env.DB.prepare(
    `INSERT INTO tiktok_auth (id, open_id, access_token, access_expires_at, refresh_token, refresh_expires_at, scope, display_name, avatar_url, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET open_id = excluded.open_id, access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
       refresh_token = excluded.refresh_token, refresh_expires_at = excluded.refresh_expires_at, scope = excluded.scope,
       display_name = excluded.display_name, avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`,
  ).bind(auth.open_id, auth.access_token, auth.access_expires_at, auth.refresh_token, auth.refresh_expires_at, auth.scope,
    prev?.open_id === auth.open_id ? prev.display_name : '', prev?.open_id === auth.open_id ? prev.avatar_url : '', auth.updated_at).run();
  if (prev?.open_id === auth.open_id) { auth.display_name = prev.display_name; auth.avatar_url = prev.avatar_url; }
  return auth;
}

export async function getAuth(env: TikTokEnv): Promise<TikTokAuth | null> {
  return (await env.DB.prepare('SELECT * FROM tiktok_auth WHERE id = 1').first<TikTokAuth>()) ?? null;
}

/** A usable access token: refreshed when it expires within five minutes. */
export async function accessToken(env: TikTokEnv): Promise<{ ok: true; token: string; auth: TikTokAuth } | { ok: false; message: string }> {
  const auth = await getAuth(env);
  if (!auth) return { ok: false, message: 'TikTok is not connected yet: open /api/tiktok/connect?key=… first.' };
  if (Date.parse(auth.access_expires_at) - Date.now() > 5 * 60 * 1000) return { ok: true, token: auth.access_token, auth };
  if (Date.parse(auth.refresh_expires_at) < Date.now()) return { ok: false, message: 'The TikTok refresh token has expired: connect again.' };
  const tok = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: auth.refresh_token });
  if (!tok.ok) return { ok: false, message: tok.message };
  const fresh = await saveTokens(env, tok.data);
  return { ok: true, token: fresh.access_token, auth: fresh };
}

export async function disconnect(env: TikTokEnv): Promise<void> {
  await env.DB.prepare('DELETE FROM tiktok_auth WHERE id = 1').run();
}

async function api<T>(token: string, path: string, body?: unknown, method = 'POST'): Promise<{ data: T; error: { code: string; message: string; log_id?: string } }> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { data: {} as T, error: { code: 'network', message: `Could not reach TikTok: ${(e as Error).message}` } };
  }
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string; log_id?: string } };
  return { data: (json.data ?? {}) as T, error: json.error ?? { code: res.ok ? 'ok' : `http_${res.status}`, message: res.ok ? '' : res.statusText } };
}

export interface UserInfo { open_id: string; display_name: string; avatar_url: string }

async function userInfo(token: string): Promise<UserInfo | null> {
  const r = await api<{ user: UserInfo }>(token, '/user/info/?fields=open_id,display_name,avatar_url', undefined, 'GET');
  return r.error.code === 'ok' && r.data.user ? r.data.user : null;
}

export interface CreatorInfo {
  creator_avatar_url: string;
  creator_username: string;
  creator_nickname: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
}

/** TikTok requires this call right before every post: it carries the privacy levels the account may use. */
export async function creatorInfo(env: TikTokEnv): Promise<{ ok: true; info: CreatorInfo; auth: TikTokAuth } | { ok: false; message: string }> {
  const t = await accessToken(env);
  if (!t.ok) return t;
  const r = await api<CreatorInfo>(t.token, '/post/publish/creator_info/query/', {});
  if (r.error.code !== 'ok') return { ok: false, message: `creator_info: ${r.error.code} ${r.error.message}` };
  return { ok: true, info: r.data, auth: t.auth };
}

export interface PostOptions {
  title: string;
  privacy?: string;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  coverMs?: number;
}

/** Upload one mp4 (bytes already in memory, at most 64 MB) and publish it. Returns the publish id to poll. */
export async function postVideo(env: TikTokEnv, video: ArrayBuffer, opts: PostOptions): Promise<{ ok: true; publishId: string; privacy: string } | { ok: false; message: string }> {
  if (video.byteLength === 0) return { ok: false, message: 'Empty video body.' };
  if (video.byteLength > MAX_SINGLE_UPLOAD) return { ok: false, message: `Video is ${(video.byteLength / 1048576).toFixed(1)} MB; the single-chunk limit is 64 MB.` };
  const ci = await creatorInfo(env);
  if (!ci.ok) return ci;
  const wanted = opts.privacy || 'PUBLIC_TO_EVERYONE';
  const options = ci.info.privacy_level_options ?? [];
  // Unaudited apps only get SELF_ONLY; fall back to the first allowed level so a test post still goes through.
  const privacy = options.includes(wanted) ? wanted : (options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0] ?? wanted);
  const t = await accessToken(env);
  if (!t.ok) return t;
  const init = await api<{ publish_id: string; upload_url: string }>(t.token, '/post/publish/video/init/', {
    post_info: {
      title: opts.title.slice(0, 2200),
      privacy_level: privacy,
      disable_duet: opts.disableDuet ?? true,
      disable_comment: opts.disableComment ?? false,
      disable_stitch: opts.disableStitch ?? true,
      video_cover_timestamp_ms: opts.coverMs ?? 1000,
    },
    source_info: { source: 'FILE_UPLOAD', video_size: video.byteLength, chunk_size: video.byteLength, total_chunk_count: 1 },
  });
  if (init.error.code !== 'ok' || !init.data.upload_url) return { ok: false, message: `video/init: ${init.error.code} ${init.error.message}` };
  let up: Response;
  try {
    up = await fetch(init.data.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', 'content-length': String(video.byteLength), 'content-range': `bytes 0-${video.byteLength - 1}/${video.byteLength}` },
      body: video,
    });
  } catch (e) {
    return { ok: false, message: `upload: ${(e as Error).message}` };
  }
  if (!(up.status === 201 || up.status === 200 || up.status === 206)) {
    return { ok: false, message: `upload: HTTP ${up.status} ${(await up.text().catch(() => '')).slice(0, 200)}` };
  }
  await env.DB.prepare('INSERT INTO tiktok_posts (publish_id, title, privacy, status, fail_reason, post_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(init.data.publish_id, opts.title, privacy, 'UPLOADED', '', '', new Date().toISOString(), new Date().toISOString()).run();
  return { ok: true, publishId: init.data.publish_id, privacy };
}

export interface PublishStatus { status: string; fail_reason?: string; publicaly_available_post_id?: string[]; uploaded_bytes?: number }

export async function postStatus(env: TikTokEnv, publishId: string): Promise<{ ok: true; status: PublishStatus } | { ok: false; message: string }> {
  const t = await accessToken(env);
  if (!t.ok) return t;
  const r = await api<PublishStatus>(t.token, '/post/publish/status/fetch/', { publish_id: publishId });
  if (r.error.code !== 'ok') return { ok: false, message: `status: ${r.error.code} ${r.error.message}` };
  const postId = r.data.publicaly_available_post_id?.[0] ? String(r.data.publicaly_available_post_id[0]) : '';
  await env.DB.prepare('UPDATE tiktok_posts SET status = ?, fail_reason = ?, post_id = CASE WHEN ? = \'\' THEN post_id ELSE ? END, updated_at = ? WHERE publish_id = ?')
    .bind(r.data.status ?? 'UNKNOWN', r.data.fail_reason ?? '', postId, postId, new Date().toISOString(), publishId).run();
  return { ok: true, status: r.data };
}

export async function listPosts(env: TikTokEnv, limit = 20): Promise<TikTokPostRow[]> {
  const r = await env.DB.prepare('SELECT * FROM tiktok_posts ORDER BY id DESC LIMIT ?').bind(limit).all<TikTokPostRow>();
  return r.results;
}

/** Small HTML page for the connect result, readable on a phone. */
export function connectPage(ok: boolean, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>TikTok ${ok ? 'connected' : 'not connected'}</title>
<style>body{font-family:system-ui,sans-serif;background:#fdf1cf;color:#1d272d;margin:0;padding:48px 24px;text-align:center}h1{font-size:28px}p{font-size:18px;line-height:1.5}.ok{color:#2e7d32}.bad{color:#b3261e}</style></head>
<body><h1 class="${ok ? 'ok' : 'bad'}">${ok ? 'TikTok connected' : 'TikTok connection failed'}</h1><p>${esc(message)}</p><p>${ok ? 'You can close this page. Posting now works from the pipeline.' : 'Open the connect link again to retry.'}</p></body></html>`;
}
