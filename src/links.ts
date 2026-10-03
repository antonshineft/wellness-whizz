/** Outbound shop links. Every iHerb link the site generates carries the owner's referral (Rewards) code. */
import type { Product, Supplement } from './db';

export interface LinkEnv {
  PRODUCT_SEARCH_URL?: string;
  IHERB_RCODE?: string;
}

const DEFAULT_SEARCH_URL = 'https://www.iherb.com/search?kw={query}';

/** iHerb search for a free-text query (used when a product has no URL of its own). */
export function searchUrl(env: LinkEnv, query: string): string {
  const template = env.PRODUCT_SEARCH_URL || DEFAULT_SEARCH_URL;
  return withReferral(env, template.replace('{query}', encodeURIComponent(query)));
}

/** Append the referral code to iherb.com URLs that do not have one. Short links (iherb.co/…) already embed it. */
export function withReferral(env: LinkEnv, url: string): string {
  const code = (env.IHERB_RCODE ?? '').trim();
  if (!code) return url;
  try {
    const u = new URL(url);
    if (!/(^|\.)iherb\.com$/i.test(u.hostname) || u.searchParams.has('rcode')) return url;
    u.searchParams.set('rcode', code);
    return u.toString();
  } catch {
    return url;
  }
}

export function isHttpUrl(url: string | undefined): boolean {
  return /^https?:\/\//i.test(url ?? '');
}

/** The product a "Buy" button should point at: the first one with a real URL, else the first one. */
export function primaryProduct(sup: Supplement): Product | undefined {
  return sup.products.find((p) => isHttpUrl(p.url)) ?? sup.products[0];
}

/** Where to send a buyer for this supplement (or one of its products). */
export function shopUrl(env: LinkEnv, sup: Supplement, product?: Product): string {
  const p = product ?? primaryProduct(sup);
  if (p && isHttpUrl(p.url)) return withReferral(env, p.url);
  return searchUrl(env, p?.name || sup.name);
}
