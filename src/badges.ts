/**
 * The Submitium badge wall (https://submitium.com): the directory badges this product is listed on,
 * rendered on the server by @submitium/badges as plain links and images, no script. It sits in the
 * footer's bottom bar (src/render/partials.ts and public/index.html carry an empty `.ww-badge-wall`
 * container; sendPage in src/index.ts fills it).
 *
 * The package reads the project's API key, checks Submitium's signature and keeps the last good wall in
 * memory. A Worker isolate is short-lived, so this module also keeps a copy in D1 (meta `submitium:wall`)
 * for 60 seconds: a page never waits for the API once one copy exists, and the copy is refreshed in the
 * background (waitUntil) when it is older than that. Without SUBMITIUM_API_KEY the container is removed.
 */
import { fetchWall, layoutWall, wallToHtml } from '@submitium/badges';
import { getMeta, setMeta } from './db';

export interface BadgeEnv {
  DB: D1Database;
  SUBMITIUM_API_KEY?: string;
}

const META_KEY = 'submitium:wall';
const FRESH_MS = 60_000;

interface Cached {
  html: string;
  at: number;
}

export async function badgeWallHtml(env: BadgeEnv, waitUntil: (job: Promise<unknown>) => void): Promise<string> {
  const apiKey = (env.SUBMITIUM_API_KEY ?? '').trim();
  if (!apiKey) return '';
  let cached: Cached | null = null;
  try {
    const raw = await getMeta(env.DB, META_KEY);
    cached = raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    cached = null;
  }
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.html;
  const refresh = async (): Promise<string> => {
    const wall = await fetchWall({ apiKey });
    if (!wall) console.warn('[badges] no wall from the Submitium API (bad key, timeout, or a failed signature check)');
    const html = wall ? wallToHtml(layoutWall(wall)) : '';
    // A failed request answers null: the previous copy stays, and the package retries after 30 seconds.
    if (html) await setMeta(env.DB, META_KEY, JSON.stringify({ html, at: Date.now() } satisfies Cached));
    return html;
  };
  const failed = (err: unknown) => console.warn(`[badges] wall refresh failed: ${err instanceof Error ? err.message : String(err)}`);
  if (cached) {
    waitUntil(refresh().catch(failed));
    return cached.html;
  }
  return refresh().catch((err) => {
    failed(err);
    return '';
  });
}

/** Fill (or, without a wall, remove) the footer's `.ww-badge-wall` container in an HTML response. */
export function withBadgeWall(res: Response, html: string): Response {
  return new HTMLRewriter()
    .on('.ww-badge-wall', {
      element(el) {
        if (html) el.setInnerContent(html, { html: true });
        else el.remove();
      },
    })
    .transform(res);
}
