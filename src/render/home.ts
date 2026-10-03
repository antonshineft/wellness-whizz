/**
 * Home page: the static index.html from the export, with the two Webflow collection lists filled from D1
 * (the slider cards and the "Explore manually" links) using HTMLRewriter.
 */
import { listSupplements, randomSupplements, type Supplement } from '../db';
import { exploreItem, homeCard } from './partials';

export async function renderHome(
  env: { DB: D1Database; ASSETS: Fetcher },
  request: Request,
  curatedOnly = false,
): Promise<Response> {
  const [assetResponse, candidates, explore] = await Promise.all([
    fetchAsset(env.ASSETS, request, '/'),
    randomSupplements(env.DB, 18, curatedOnly),
    listSupplements(env.DB, 200, curatedOnly),
  ]);
  if (!assetResponse.ok) return assetResponse;
  // Six slides; supplements with real product photos first.
  const withPhoto = candidates.filter((s) => s.products.some((p) => p.image));
  const slides = [...withPhoto, ...candidates.filter((s) => !withPhoto.includes(s))].slice(0, 6);

  // Each of the six slides shows one supplement (the Webflow design sizes one card to the full slide width).
  let slideIndex = 0;
  const cardFor = (i: number): Supplement | undefined => (slides.length ? slides[i % slides.length] : undefined);

  const rewriter = new HTMLRewriter()
    .on('.collection-list-2', {
      element(el) {
        const supplement = cardFor(slideIndex++);
        if (supplement) el.setInnerContent(homeCard(supplement), { html: true });
      },
    })
    .on('.collection-list-wrapper-2 .empty-state', {
      element(el) {
        if (slides.length) el.remove();
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
