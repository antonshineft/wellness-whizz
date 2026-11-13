/**
 * Posting to X (Twitter) from the Worker with OAuth 1.0a user context: the four keys from an X developer app with
 * "Read and write" permission. The free API tier allows a few hundred posts a month, far more than this site uses.
 */
export interface XEnv {
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;
}

const TWEETS_URL = 'https://api.x.com/2/tweets';

export function xEnabled(env: XEnv): boolean {
  return !!(env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET);
}

function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function hmacSha1(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** OAuth 1.0a Authorization header. A JSON or multipart body is not part of the signature; the query parameters of a
 *  GET are, so they are passed separately from the address. */
export async function oauthHeader(env: XEnv, method: string, url: string, query: Record<string, string> = {}): Promise<string> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const params: Record<string, string> = {
    oauth_consumer_key: env.X_API_KEY!,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN!,
    oauth_version: '1.0',
  };
  const signed: Record<string, string> = { ...params, ...query };
  const base = [method.toUpperCase(), pct(url), pct(Object.keys(signed).sort().map((k) => `${pct(k)}=${pct(signed[k])}`).join('&'))].join('&');
  const signature = await hmacSha1(`${pct(env.X_API_SECRET!)}&${pct(env.X_ACCESS_SECRET!)}`, base);
  const all: Record<string, string> = { ...params, oauth_signature: signature };
  return 'OAuth ' + Object.keys(all).sort().map((k) => `${pct(k)}="${pct(all[k])}"`).join(', ');
}

export interface PostedTweet {
  id: string;
}

/** Post one tweet, optionally as a reply (for threads) and optionally carrying an uploaded video. */
export async function postTweet(env: XEnv, text: string, replyTo?: string, mediaId?: string): Promise<PostedTweet> {
  const body: Record<string, unknown> = { text };
  if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
  if (mediaId) body.media = { media_ids: [mediaId] };
  const res = await fetch(TWEETS_URL, {
    method: 'POST',
    headers: { authorization: await oauthHeader(env, 'POST', TWEETS_URL), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as { data?: { id?: string }; detail?: string; title?: string; errors?: unknown };
  if (!res.ok || !data.data?.id) throw new Error(`X API ${res.status}: ${(data.detail || data.title || JSON.stringify(data.errors || data)).slice(0, 300)}`);
  return { id: data.data.id };
}

/** Post a thread: each tweet replies to the previous one; a video, when given, goes on the first. Returns the first tweet's id. */
export async function postThread(env: XEnv, tweets: string[], mediaId?: string): Promise<string> {
  let last: string | undefined;
  let first = '';
  for (const text of tweets) {
    const posted = await postTweet(env, text, last, first ? undefined : mediaId);
    last = posted.id;
    if (!first) first = posted.id;
  }
  return first;
}

/** X counts every URL as 23 characters; the rest is counted roughly per character. */
export function tweetLength(text: string): number {
  return text.replace(/https?:\/\/\S+/g, 'x'.repeat(23)).length;
}

/**
 * Whether this account's developer access accepts a video upload: asks X to open an upload of a small mp4 and reports
 * the answer. Nothing is uploaded or posted; an upload that is opened and never filled expires by itself.
 */
export async function videoUploadCheck(env: XEnv): Promise<{ status: number; body: string }> {
  const url = 'https://api.x.com/2/media/upload/initialize';
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: await oauthHeader(env, 'POST', url), 'content-type': 'application/json' },
    body: JSON.stringify({ media_type: 'video/mp4', total_bytes: 1_048_576, media_category: 'tweet_video' }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: (await res.text()).slice(0, 500) };
}

const UPLOAD_URL = 'https://api.x.com/2/media/upload';
const UPLOAD_CHUNK = 4 * 1024 * 1024; // X takes at most 5 MB a piece

interface UploadAnswer {
  data?: { id?: string; processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } } };
  detail?: string;
  title?: string;
  errors?: unknown;
}

async function uploadCall(env: XEnv, method: 'GET' | 'POST', url: string, body?: unknown, query: Record<string, string> = {}): Promise<UploadAnswer> {
  const qs = Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '';
  const res = await fetch(url + qs, {
    method,
    headers: { authorization: await oauthHeader(env, method, url, query), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as UploadAnswer;
  if (!res.ok) throw new Error(`X upload ${res.status}: ${(data.detail || data.title || JSON.stringify(data.errors || data)).slice(0, 300)}`);
  return data;
}

/**
 * Upload an mp4 to X in pieces and wait until X has processed it. Returns the media id a tweet can carry.
 * An upload that is never attached to a tweet expires by itself after a day.
 */
export async function uploadVideo(env: XEnv, bytes: ArrayBuffer): Promise<string> {
  const init = await uploadCall(env, 'POST', `${UPLOAD_URL}/initialize`, { media_type: 'video/mp4', total_bytes: bytes.byteLength, media_category: 'tweet_video' });
  const id = init.data?.id;
  if (!id) throw new Error('X opened no upload');
  for (let part = 0, at = 0; at < bytes.byteLength; part++, at += UPLOAD_CHUNK) {
    const form = new FormData();
    form.append('segment_index', String(part));
    form.append('media', new Blob([bytes.slice(at, at + UPLOAD_CHUNK)], { type: 'video/mp4' }), 'video.mp4');
    const url = `${UPLOAD_URL}/${id}/append`;
    const res = await fetch(url, { method: 'POST', headers: { authorization: await oauthHeader(env, 'POST', url) }, body: form, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`X upload piece ${part + 1}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  let info = (await uploadCall(env, 'POST', `${UPLOAD_URL}/${id}/finalize`)).data?.processing_info;
  for (let checks = 0; info && info.state !== 'succeeded'; checks++) {
    if (info.state === 'failed') throw new Error(`X could not process the video: ${info.error?.message ?? 'no reason given'}`);
    if (checks >= 40) throw new Error('X was still processing the video after several minutes');
    await new Promise((r) => setTimeout(r, Math.min(15, Math.max(1, info?.check_after_secs ?? 3)) * 1000));
    info = (await uploadCall(env, 'GET', UPLOAD_URL, undefined, { media_id: id, command: 'STATUS' })).data?.processing_info;
  }
  return id;
}
