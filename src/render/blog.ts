/** /blog and /blog/:slug — long-form articles with iHerb referral links and product blocks from the catalogue. */
import type { BlogPost } from '../blog/types';
import type { Supplement } from '../db';
import { escapeHtml } from '../html';
import { primaryProduct, searchUrl, shopUrl, type LinkEnv } from '../links';
import { page } from './layout';
import { faqHtml, formatDate, pageShell, quizCta, reviewedLine } from './pages';
import { WF_PAGE_IDS, blendAttr, buyButton, captureBox, cardImage } from './partials';

export interface BlogContext {
  env: LinkEnv;
  /** Site origin for canonical URLs and structured data, e.g. https://aiww.io */
  origin: string;
  /** Supplements referenced by the posts, by slug (missing ones degrade to search links). */
  supplements: Map<string, Supplement>;
}

const DISCLOSURE =
  'Wellness Whizz earns a commission on purchases made through iHerb links on this page, at no extra cost to you. ' +
  'This article is for information only and is not medical advice; talk to a doctor or pharmacist before starting a supplement.';

export { formatDate };

function supplementPhoto(sup: Supplement | undefined, alt: string, attrs = ''): string {
  const product = sup?.products.find((p) => p.image);
  if (product?.image) return `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(alt)}" loading="lazy" ${attrs}${blendAttr(product)}>`;
  if (sup) return cardImage(sup, `${attrs} alt="${escapeHtml(alt)}"`);
  return '';
}

function shopItem(env: LinkEnv, sup: Supplement): string {
  const product = primaryProduct(sup);
  const href = escapeHtml(shopUrl(env, sup, product));
  const sub = product ? [product.brand, product.name].filter(Boolean).join(' · ') : sup.category;
  return `
          <div class="ww-shop-item">
            <div class="ww-shop-top">
              <a href="${href}" target="_blank" rel="noopener nofollow sponsored" class="ww-shop-thumb" data-track="outbound_click" data-slug="${escapeHtml(sup.slug)}"${product ? ` data-product="${escapeHtml(product.name)}"` : ''}>${supplementPhoto(sup, product?.name ?? sup.name, 'width="60" height="60"')}</a>
              <div class="ww-shop-info">
                <div class="ww-shop-name">${escapeHtml(sup.name)}</div>
                <div class="ww-shop-brand">${escapeHtml(sub)}</div>
              </div>
            </div>
            <div class="ww-shop-actions"><a href="/supplement/${escapeHtml(sup.slug)}" class="ww-shop-link">Full profile</a>${buyButton(env, sup, 'ww-shop-buy')}</div>
          </div>`;
}

function shopBlock(ctx: BlogContext, post: BlogPost, slugs: string[], title: string, extraClass = ''): string {
  const sups = slugs.map((s) => ctx.supplements.get(s)).filter((s): s is Supplement => !!s);
  if (!sups.length) {
    // Catalogue not loaded yet (fresh deployment): fall back to a search link so the article still sells.
    const q = slugs[0]?.replace(/-[0-9a-f]{5}$/, '').replace(/-/g, ' ') ?? post.title;
    return `
        <div class="ww-shop ${extraClass}"><h4>${escapeHtml(title)}</h4>
          <a href="${escapeHtml(searchUrl(ctx.env, q))}" target="_blank" rel="noopener nofollow sponsored" class="fakebutton ww-buy ww-shop-buy w-button" data-track="outbound_click" data-slug="blog:${escapeHtml(post.slug)}" data-product="${escapeHtml(q)}">Find on iHerb</a>
        </div>`;
  }
  return `
        <div class="ww-shop ${extraClass}"><h4>${escapeHtml(title)}</h4>${sups.map((s) => shopItem(ctx.env, s)).join('')}
          <p class="ww-note" style="margin:12px 0 0">Prices and availability are set by iHerb.</p>
        </div>`;
}

/** The interactive protein calculator (<ww-protein-calculator>); public/js/protein-calc.js fills in the result. */
function proteinCalculator(): string {
  return `
<div class="ww-calc" data-protein-calc>
  <h3>Protein calculator</h3>
  <p class="ww-calc-intro">Enter your weight and goal. The result uses the per-kilogram ranges from the studies discussed in this article.</p>
  <div class="ww-calc-grid">
    <label class="ww-calc-field"><span>Body weight</span><span class="ww-calc-weight"><input type="number" name="weight" min="30" max="250" step="1" value="70" inputmode="decimal" aria-label="Body weight"><select name="unit" aria-label="Unit"><option value="kg">kg</option><option value="lb">lb</option></select></span></label>
    <label class="ww-calc-field"><span>Goal</span><select name="goal">
      <option value="muscle">Build muscle</option>
      <option value="fatloss">Lose fat and keep muscle</option>
      <option value="maintain">Stay healthy, moderately active</option>
      <option value="endurance">Endurance training</option>
      <option value="older">Over 65</option>
      <option value="sedentary">Mostly sedentary</option>
    </select></label>
    <label class="ww-calc-field"><span>Meals a day</span><select name="meals"><option value="3">3</option><option value="4" selected>4</option><option value="5">5</option></select></label>
  </div>
  <div class="ww-calc-result" data-result aria-live="polite"><noscript>Turn on JavaScript to use the calculator, or use the table below: multiply your weight in kilograms by 1.6 to 2.2 for muscle gain.</noscript></div>
</div>`;
}

/** The interactive caffeine chart (<ww-caffeine-chart>); public/js/caffeine-chart.js draws it and fills in the result. */
function caffeineChart(): string {
  return `
<div class="ww-calc ww-caf" data-caffeine-chart>
  <h3>How much caffeine is still in you at bedtime?</h3>
  <p class="ww-calc-intro">Add what you drink and when. Drag a cup along the day, drag the bedtime line, or move across the chart to read any moment.</p>
  <div class="ww-caf-drinks" data-drinks></div>
  <div class="ww-caf-row">
    <button type="button" class="ww-caf-add" data-add>+ Add a drink</button>
    <label class="ww-calc-field"><span>Bedtime</span><input type="time" name="bed" value="23:00"></label>
    <label class="ww-calc-field"><span>How fast you clear caffeine</span><select name="half">
      <option value="3">Fast: half gone in 3 hours</option>
      <option value="5" selected>Typical: half gone in 5 hours</option>
      <option value="7">Slow: half gone in 7 hours</option>
      <option value="10">Very slow: half gone in 10 hours</option>
    </select></label>
  </div>
  <div class="ww-caf-plot" data-plot></div>
  <div class="ww-calc-result" data-result aria-live="polite"><noscript>Turn on JavaScript to use the chart. As a rule of thumb, half of a cup's caffeine is still in you about five hours later, and a quarter after ten.</noscript></div>
  <p class="ww-calc-note">A simplified model: each drink is absorbed within about 45 minutes and then cleared at the pace you chose. It starts the day from zero and cannot know your own metabolism, so read it as an estimate, not a measurement.</p>
</div>`;
}

/** Turn the article conventions (iherb: links, <ww-shop>, <ww-quiz>) into live markup. */
export function expandArticleHtml(ctx: BlogContext, post: BlogPost): string {
  let html = post.html;
  html = html.replace(/href="iherb:([^"]+)"/g, (_m, query: string) => {
    const q = query.trim();
    return (
      `href="${escapeHtml(searchUrl(ctx.env, q))}" target="_blank" rel="noopener nofollow sponsored" ` +
      `data-track="outbound_click" data-slug="blog:${escapeHtml(post.slug)}" data-product="${escapeHtml(q)}"`
    );
  });
  html = html.replace(/<ww-shop\s+slugs="([^"]+)"\s*>\s*<\/ww-shop>/g, (_m, list: string) =>
    shopBlock(ctx, post, list.split(',').map((s) => s.trim()).filter(Boolean), 'Related products on iHerb', 'ww-shop-inline'),
  );
  html = html.replace(/<ww-protein-calculator\s*>\s*<\/ww-protein-calculator>/g, () => proteinCalculator());
  html = html.replace(/<ww-caffeine-chart\s*>\s*<\/ww-caffeine-chart>/g, () => caffeineChart());
  html = html.replace(/<ww-quiz\s*>\s*<\/ww-quiz>/g, () => quizCta('Not sure which one is right for you?', 'The free two-minute quiz weighs your goals, diet and the supplements you already take, then explains its picks.'));
  return html;
}

/** A category as a filter key: "Dosage guides" -> "dosage-guides" (also the ?category= value in the URL). */
export function categoryKey(category: string): string {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function postCard(ctx: BlogContext, post: BlogPost, hidden = false): string {
  const sup = ctx.supplements.get(post.heroSupplement);
  const haystack = `${post.title} ${post.excerpt} ${post.category}`.toLowerCase().replace(/\s+/g, ' ').trim();
  return `
        <a href="/blog/${escapeHtml(post.slug)}" class="ww-post-card${hidden ? ' is-hidden' : ''}" data-category="${escapeHtml(categoryKey(post.category))}" data-search="${escapeHtml(haystack)}">
          <div class="ww-post-card-media">${supplementPhoto(sup, post.title, 'width="180" height="180"')}</div>
          <div class="ww-post-card-body">
            <span class="ww-tag">${escapeHtml(post.category)}</span>
            <h2>${escapeHtml(post.title)}</h2>
            <p>${escapeHtml(post.excerpt)}</p>
            <div class="ww-post-meta">${escapeHtml(formatDate(post.date))} · ${post.readingMinutes} min read</div>
          </div>
        </a>`;
}

/** Cards shown on the blog index before the "Show more" button (all cards are in the HTML; the rest start hidden). */
const BLOG_PAGE_SIZE = 6;

export function renderBlogIndex(ctx: BlogContext, posts: readonly BlogPost[]): string {
  // Category chips with counts, most-written-about first; the key is what the cards carry in data-category.
  const categories = new Map<string, { label: string; count: number }>();
  for (const p of posts) {
    const key = categoryKey(p.category);
    const c = categories.get(key);
    if (c) c.count++;
    else categories.set(key, { label: p.category, count: 1 });
  }
  const chips = [...categories.entries()].sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label));
  const chip = (value: string, label: string, count: number, active = false) =>
    `<button type="button" class="ww-tag ww-rchip${active ? ' is-active' : ''}" data-category="${escapeHtml(value)}" aria-pressed="${active}">${escapeHtml(label)} <b>${count}</b></button>`;
  const body = `
      <section class="ww-blog-frame">
        <p class="ww-blog-intro">Long reads on how supplements actually work, what the research says, and how to read a label before you buy. Every article is checked against primary sources and links to the products it discusses on iHerb.</p>
        <div class="ww-bfilter" data-blog-filter data-page-size="${BLOG_PAGE_SIZE}">
          <div class="ww-rfilter-row"><label class="ww-rfilter-label" for="ww-blog-search">Search</label><div class="ww-bsearch-wrap"><input type="search" id="ww-blog-search" class="ww-bsearch" data-blog-search placeholder="Search articles, e.g. magnesium, sleep, creatine" autocomplete="off" aria-label="Search articles"></div></div>
          <div class="ww-rfilter-row"><span class="ww-rfilter-label">Category</span><div class="ww-rfilter-chips">${chip('', 'All', posts.length, true)}${chips.map(([key, c]) => chip(key, c.label, c.count)).join('')}</div></div>
          <p class="ww-rfilter-count" data-blog-count aria-live="polite"></p>
          <div hidden data-blog-strings><span data-k="all">Showing all {n} articles</span><span data-k="some">Showing {n} of {x} articles</span><span data-k="match">Showing {n} of {x} matching articles</span><span data-k="more">Show more ({n} left)</span></div>
        </div>
        <div class="ww-posts" id="ww-posts" data-blog-list>${posts.map((p, i) => postCard(ctx, p, i >= BLOG_PAGE_SIZE)).join('')}
        </div>
        <p class="ww-bempty" data-blog-empty hidden>No articles match that yet. Try another word, or clear the filters.</p>${
          posts.length > BLOG_PAGE_SIZE
            ? `
        <div class="ww-more-wrap"><button type="button" class="bignavbutton w-button ww-teaser-btn" data-blog-more>Show more</button></div>`
            : ''
        }
      </section>
      <div style="margin-top:32px">${captureBox({ source: 'newsletter' })}</div>${quizCta()}`;
  const shell = pageShell({
    eyebrow: 'Blog',
    title: 'Evidence first, then the shopping list',
    lead: 'Guides written for people who want to understand what they are taking: forms, doses, interactions, and what the studies really show.',
    body,
  });
  const head = `
  <link rel="canonical" href="${escapeHtml(ctx.origin)}/blog">`;
  return page({
    title: 'Blog',
    description: 'Evidence-based guides to supplements: which forms to choose, how much to take, what the research shows, and where to buy on iHerb.',
    pageId: WF_PAGE_IDS.supplement,
    bodyClass: 'body-2',
    head,
    body: shell,
    scripts: '  <script src="/js/blog.js"></script>',
  });
}

function jsonLd(ctx: BlogContext, post: BlogPost, imageUrl: string | null): string {
  const article = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    dateModified: post.date,
    author: { '@type': 'Organization', name: 'Wellness Whizz editorial team', url: `${ctx.origin}/about` },
    publisher: { '@type': 'Organization', name: 'Wellness Whizz', url: ctx.origin, logo: { '@type': 'ImageObject', url: `${ctx.origin}/images/webclip.png` } },
    mainEntityOfPage: `${ctx.origin}/blog/${post.slug}`,
    ...(imageUrl ? { image: imageUrl } : {}),
    keywords: post.tags.join(', '),
  };
  const faq = post.faq.length
    ? {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: post.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      }
    : null;
  const safe = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c');
  return `
  <script type="application/ld+json">${safe(article)}</script>${faq ? `\n  <script type="application/ld+json">${safe(faq)}</script>` : ''}`;
}

export function renderBlogPost(ctx: BlogContext, post: BlogPost, related: readonly BlogPost[]): string {
  const hero = ctx.supplements.get(post.heroSupplement);
  const heroProduct = hero?.products.find((p) => p.image);
  const imageUrl = heroProduct?.image ? new URL(heroProduct.image, ctx.origin).toString() : null;
  const shop = shopBlock(ctx, post, post.shop, 'Shop this article');
  const sources = post.sources.length
    ? `
      <section class="ww-sources">
        <h2>Sources</h2>
        <ol>${post.sources.map((s) => `<li><a href="${escapeHtml(s.href)}" target="_blank" rel="noopener">${escapeHtml(s.label)}</a></li>`).join('')}</ol>
      </section>`
    : '';
  const relatedHtml = related.length
    ? `
      <section class="ww-related">
        <h2>Keep reading</h2>
        <div class="ww-posts">${related.map((p) => postCard(ctx, p)).join('')}
        </div>
      </section>`
    : '';
  const body = `
      <div class="ww-article-layout">
        <article class="ww-prose">
          <div class="ww-article-meta"><span class="ww-tag">${escapeHtml(post.category)}</span><span>${escapeHtml(formatDate(post.date))}</span><span>${post.readingMinutes} min read</span><a href="/about#editorial" class="ww-byline">By the Wellness Whizz editorial team</a></div>
          ${reviewedLine(post.date, 'ww-reviewed-top')}
          ${expandArticleHtml(ctx, post)}
          <div class="ww-only-mobile">${shop}</div>${faqHtml(post.faq)}${sources}
          <p class="ww-note">${escapeHtml(DISCLOSURE)} <a href="/about#disclaimer">Read our full medical disclaimer.</a></p>
        </article>
        <aside class="ww-article-aside ww-only-desktop">${shop}
          <a href="/wellness-quiz" class="ww-quiz-card"><div class="ww-quiz-card-frame"><div class="ww-quiz-card-media"><img src="/images/quiz-still.webp" width="720" height="400" loading="lazy" alt=""></div><h4>Free personal list</h4><p>Two minutes, no account. The advisor weighs your goals and what you already take.</p><span class="fakebutton ww-buy ww-shop-buy">Start the quiz</span></div></a>
          ${captureBox({ source: 'newsletter', compact: true })}
        </aside>
      </div>${relatedHtml}`;
  const shell = pageShell({
    eyebrow: post.category,
    title: post.title,
    lead: post.description,
    body,
    heroAside: hero ? `<div class="ww-page-hero-media">${supplementPhoto(hero, heroProduct?.name ?? hero.name, 'width="232" height="232"')}</div>` : '',
  });
  const head = `
  <link rel="canonical" href="${escapeHtml(ctx.origin)}/blog/${escapeHtml(post.slug)}">
  <meta property="og:type" content="article">
  <meta property="article:published_time" content="${escapeHtml(post.date)}">${imageUrl ? `\n  <meta property="og:image" content="${escapeHtml(imageUrl)}">\n  <meta name="twitter:image" content="${escapeHtml(imageUrl)}">` : ''}${jsonLd(ctx, post, imageUrl)}`;
  return page({
    title: post.seoTitle ?? post.title,
    description: post.description,
    pageId: WF_PAGE_IDS.supplement,
    bodyClass: 'body-2',
    head,
    body: `<div class="ww-progress" aria-hidden="true"></div>${shell}`,
    scripts: `  <script src="/js/reading-progress.js"></script>${post.html.includes('<ww-protein-calculator') ? '\n  <script src="/js/protein-calc.js" defer></script>' : ''}${post.html.includes('<ww-caffeine-chart') ? '\n  <script src="/js/caffeine-chart.js" defer></script>' : ''}`,
  });
}
