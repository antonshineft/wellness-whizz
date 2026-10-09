/**
 * Home page: the static index.html from the export, with the two Webflow collection lists filled from D1
 * (the carousel cards and the "Explore manually" links) using HTMLRewriter.
 */
import { POSTS } from '../blog';
import { getSupplementsBySlugs, listSupplements, randomSupplements } from '../db';
import type { LinkEnv } from '../links';
import { postCard } from './blog';
import { exploreItem, homeCard } from './partials';

export async function renderHome(
  env: LinkEnv & { DB: D1Database; ASSETS: Fetcher },
  request: Request,
  curatedOnly = false,
): Promise<Response> {
  const [assetResponse, candidates, explore, postSupplements] = await Promise.all([
    fetchAsset(env.ASSETS, request, '/'),
    randomSupplements(env.DB, 18, curatedOnly),
    listSupplements(env.DB, 200, curatedOnly),
    getSupplementsBySlugs(env.DB, POSTS.map((p) => p.heroSupplement)),
  ]);
  const blogCtx = { env, origin: new URL(request.url).origin, supplements: postSupplements };
  if (!assetResponse.ok) return assetResponse;
  // Carousel cards: supplements with real product photos first. The browser script loops them seamlessly.
  const withPhoto = candidates.filter((s) => s.products.some((p) => p.image));
  const cards = [...withPhoto, ...candidates.filter((s) => !withPhoto.includes(s))].slice(0, 10);

  const rewriter = new HTMLRewriter()
    // The home page answers on several URLs (query strings, the old index.html); one canonical for all of them.
    .on('head', {
      element(el) {
        el.append(`<link rel="canonical" href="${blogCtx.origin}/">`, { html: true });
      },
    })
    .on('.ww-carousel-track', {
      element(el) {
        if (cards.length) el.setInnerContent(cards.map(homeCard).join(''), { html: true });
      },
    })
    .on('.ww-teaser-posts', {
      element(el) {
        el.setInnerContent(POSTS.slice(0, 3).map((p) => postCard(blogCtx, p)).join(''), { html: true });
      },
    })
    .on('.linksnav', {
      element(el) {
        if (explore.length) el.setInnerContent(explore.map(exploreItem).join(''), { html: true });
      },
    })
    .on('.collection-list-wrapper .w-dyn-empty', {
      element(el) {
        if (explore.length) el.remove();
      },
    });

  const transformed = rewriter.transform(assetResponse);
  const headers = new Headers(transformed.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'public, max-age=60');
  return new Response(transformed.body, { status: 200, headers });
}

/** Fetch a static asset through the ASSETS binding, following the redirects that html_handling may issue. */
export async function fetchAsset(assets: Fetcher, request: Request, path: string): Promise<Response> {
  let url = new URL(path, request.url);
  for (let hop = 0; hop < 3; hop++) {
    const res = await assets.fetch(new Request(url.toString(), { method: 'GET', headers: { accept: 'text/html' } }));
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    return res;
  }
  return new Response('Too many redirects', { status: 508 });
}
