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

/** OAuth 1.0a Authorization header for a JSON POST (body is not part of the signature). */
export async function oauthHeader(env: XEnv, method: string, url: string): Promise<string> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const params: Record<string, string> = {
    oauth_consumer_key: env.X_API_KEY!,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN!,
    oauth_version: '1.0',
  };
  const base = [method.toUpperCase(), pct(url), pct(Object.keys(params).sort().map((k) => `${pct(k)}=${pct(params[k])}`).join('&'))].join('&');
  const signature = await hmacSha1(`${pct(env.X_API_SECRET!)}&${pct(env.X_ACCESS_SECRET!)}`, base);
  const all: Record<string, string> = { ...params, oauth_signature: signature };
  return 'OAuth ' + Object.keys(all).sort().map((k) => `${pct(k)}="${pct(all[k])}"`).join(', ');
}

export interface PostedTweet {
  id: string;
}

/** Post one tweet, optionally as a reply (for threads). */
export async function postTweet(env: XEnv, text: string, replyTo?: string): Promise<PostedTweet> {
  const body: Record<string, unknown> = { text };
  if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
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

/** Post a thread: each tweet replies to the previous one. Returns the first tweet's id. */
export async function postThread(env: XEnv, tweets: string[]): Promise<string> {
  let last: string | undefined;
  let first = '';
  for (const text of tweets) {
    const posted = await postTweet(env, text, last);
    last = posted.id;
    if (!first) first = posted.id;
  }
  return first;
}

/** X counts every URL as 23 characters; the rest is counted roughly per character. */
export function tweetLength(text: string): number {
  return text.replace(/https?:\/\/\S+/g, 'x'.repeat(23)).length;
}
