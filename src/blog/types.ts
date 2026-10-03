/**
 * Blog posts are bundled with the worker (one module per article under src/blog/posts). The renderer turns a few
 * conventions in `html` into live markup:
 *   - <a href="iherb:magnesium glycinate">…</a>  -> iHerb search link with the site's referral code + click tracking
 *   - <a href="/supplement/<slug>">…</a>          -> internal link to a supplement page (left as is)
 *   - <ww-shop slugs="magnesium-32aa0,zinc-fe1df"></ww-shop> -> product cards for those supplements (photos, Buy on iHerb)
 *   - <ww-quiz></ww-quiz>                         -> "Take the quiz" call-to-action block
 */
export interface BlogSource {
  /** Short citation shown in the Sources list, e.g. "NIH Office of Dietary Supplements — Magnesium fact sheet". */
  label: string;
  href: string;
}

export interface BlogFaq {
  q: string;
  a: string;
}

export interface BlogPost {
  /** URL path segment: /blog/<slug>. Lowercase, hyphens only. */
  slug: string;
  title: string;
  /** Optional shorter title for the <title> tag (keep it under 60 characters); the h1 and structured data use `title`. */
  seoTitle?: string;
  /** Meta description, 140–160 characters. */
  description: string;
  /** One or two sentences shown on the blog index card. */
  excerpt: string;
  /** ISO date, e.g. "2026-10-03". */
  date: string;
  readingMinutes: number;
  /** e.g. "Minerals", "Fatty acids", "Vitamins", "Sleep". */
  category: string;
  tags: string[];
  /** Supplement slug whose product photo illustrates the post (index card + header). */
  heroSupplement: string;
  /** Supplement slugs for the "Shop this article" block at the end. */
  shop: string[];
  /** Article body (see conventions above). h2/h3/p/ul/ol/table/blockquote/strong/em/a only, no inline styles. */
  html: string;
  faq: BlogFaq[];
  sources: BlogSource[];
}
