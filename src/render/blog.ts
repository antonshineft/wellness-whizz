/** /blog and /blog/:slug — long-form articles with iHerb referral links and product blocks from the catalogue. */
import type { BlogPost } from '../blog/types';
import type { Supplement } from '../db';
import { escapeHtml } from '../html';
import { primaryProduct, searchUrl, shopUrl, type LinkEnv } from '../links';
import { page } from './layout';
import { faqHtml, pageShell, quizCta } from './pages';
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

export function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

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
            <a href="${href}" target="_blank" rel="noopener nofollow sponsored" class="ww-shop-thumb" data-track="outbound_click" data-slug="${escapeHtml(sup.slug)}"${product ? ` data-product="${escapeHtml(product.name)}"` : ''}>${supplementPhoto(sup, product?.name ?? sup.name, 'width="60" height="60"')}</a>
            <div class="ww-shop-info">
              <div class="ww-shop-name">${escapeHtml(sup.name)}</div>
              <div class="ww-shop-brand">${escapeHtml(sub)}</div>
              <a href="/supplement/${escapeHtml(sup.slug)}">Full profile</a>
            </div>
            ${buyButton(env, sup, 'ww-shop-buy')}
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
  html = html.replace(/<ww-quiz\s*>\s*<\/ww-quiz>/g, () => quizCta('Not sure which one is right for you?', 'The free two-minute quiz weighs your goals, diet and the supplements you already take, then explains its picks.'));
  return html;
}

export function postCard(ctx: BlogContext, post: BlogPost): string {
  const sup = ctx.supplements.get(post.heroSupplement);
  return `
        <a href="/blog/${escapeHtml(post.slug)}" class="ww-post-card">
          <div class="ww-post-card-media">${supplementPhoto(sup, post.title, 'width="180" height="180"')}</div>
          <div class="ww-post-card-body">
            <span class="ww-tag">${escapeHtml(post.category)}</span>
            <h2>${escapeHtml(post.title)}</h2>
            <p>${escapeHtml(post.excerpt)}</p>
            <div class="ww-post-meta">${escapeHtml(formatDate(post.date))} · ${post.readingMinutes} min read</div>
          </div>
        </a>`;
}

export function renderBlogIndex(ctx: BlogContext, posts: readonly BlogPost[]): string {
  const body = `
      <p class="ww-blog-intro">Long reads on how supplements actually work, what the research says, and how to read a label before you buy. Every article is checked against primary sources and links to the products it discusses on iHerb.</p>
      <div class="ww-posts">${posts.map((p) => postCard(ctx, p)).join('')}
      </div>
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
    author: { '@type': 'Organization', name: 'Wellness Whizz', url: ctx.origin },
    publisher: { '@type': 'Organization', name: 'Wellness Whizz', url: ctx.origin },
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
          <div class="ww-article-meta"><span class="ww-tag">${escapeHtml(post.category)}</span><span>${escapeHtml(formatDate(post.date))}</span><span>${post.readingMinutes} min read</span><span>By the Wellness Whizz editorial team</span></div>
          ${expandArticleHtml(ctx, post)}
          <div class="ww-only-mobile">${shop}</div>${faqHtml(post.faq)}${sources}
          <p class="ww-note">${escapeHtml(DISCLOSURE)}</p>
        </article>
        <aside class="ww-article-aside ww-only-desktop">${shop}
          <div class="ww-shop"><h4>Free personal list</h4><p class="ww-note" style="margin:0 0 12px">Two minutes, no account. The advisor weighs your goals and what you already take.</p><a href="/wellness-quiz" class="fakebutton ww-buy ww-shop-buy w-button">Start the quiz</a></div>
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
    title: post.title,
    description: post.description,
    pageId: WF_PAGE_IDS.supplement,
    bodyClass: 'body-2',
    head,
    body: `<div class="ww-progress" aria-hidden="true"></div>${shell}`,
    scripts: '  <script src="/js/reading-progress.js"></script>',
  });
}
